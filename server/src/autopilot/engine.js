const store = require("./store");
const config = require("./settings");
const market = require("./market");
const { STRATEGIES, evaluateDetailed } = require("./strategies");
const tracking = require("./tracking");
const notices = require("./notifications");
const users = require("./users");
const alpaca = require("../providers/alpacaService");
const finnhub = require("../providers/finnhubService");
const universe = require("./universe");
const history = require("./history");
const selection = require("./selection");
const { logMemory } = require("../memoryDiagnostics");
const SELECTION_INTRADAY_CACHE_LIMIT = 200;
const INTRADAY_BATCH_SIZE = Math.min(
  20,
  Math.max(5, Number(process.env.AUTOPILOT_INTRADAY_BATCH_SIZE || 10) || 10),
);
let running = false,
  timer,
  scanRunning = false,
  socket,
  streamKey = "",
  streamStatus = "disconnected";
const prices = new Map();
let lastUniverseAttempt = 0;
function state(patch) {
  return store.put("runtime", "engine", {
    ...store.get("runtime", "engine"),
    ...patch,
  });
}
function liveQuote(symbol, snapshot, now) {
  const stream = prices.get(symbol);
  if (
    stream &&
    now - Date.parse(stream.at) <= 90000 &&
    Date.parse(stream.at) <= now + 1000
  )
    return stream;
  return market.freshPrice(snapshot, now);
}
function watch(symbols) {
  const key = [...symbols].sort().join(",");
  if (key === streamKey && socket && [0, 1].includes(socket.readyState)) return;
  if (socket) socket.close();
  streamKey = key;
  if (!symbols.length) return;
  socket = alpaca.openStream(
    symbols,
    (item) => {
      if (
        item.T === "t" &&
        item.p > 0 &&
        (!prices.get(item.S) ||
          Date.parse(item.t) > Date.parse(prices.get(item.S).at))
      )
        prices.set(item.S, { price: item.p, at: item.t });
    },
    (status) => {
      streamStatus = status;
    },
  );
}
async function prepare(now) {
  if (Date.now() - lastUniverseAttempt < 300000) return universe.getRows(now);
  lastUniverseAttempt = Date.now();
  return universe.ensure(now);
}
async function snapshots(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 200)
    for (const [s, q] of await alpaca.getSnapshots({
      symbols: symbols.slice(i, i + 200),
    }))
      out.set(s, q);
  return out;
}
function symbolsForSelectionIntradayCache(rows, snap, today, now) {
  return rows
    .map((row) => {
      const snapshot = snap.get(row.symbol);
      const price = market.freshPrice(snapshot, now);
      const sameDay = market.nyDate(Date.parse(snapshot?.dailyBar?.t || 0)) === today.date;
      const volume = sameDay ? Number(snapshot?.dailyBar?.v || 0) * Number(snapshot?.dailyBar?.c || 0) : 0;
      return { symbol: row.symbol, score: price && price.price >= 5 ? volume : 0 };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, SELECTION_INTRADAY_CACHE_LIMIT)
    .map((row) => row.symbol);
}
async function scan(now, calendar, today) {
  if (scanRunning) return;
  scanRunning = true;
  state({ scanning: true });
  const scanId = `${today.date}:${now}`;
  const startedAt = Date.now();
  logMemory("scan:start");
  try {
    const profiles = users
      .all()
      .map((u) => ({ id: u.id, settings: config.read(u.id) }))
      .filter((u) => u.settings.enabled);
    if (!profiles.length) {
      state({ lastScanAt: new Date().toISOString(), scanning: false });
      return;
    }
    const active = profiles.flatMap((user) =>
      store
        .listUser(user.id, "trade")
        .filter((t) => t.status === "open")
        .map((t) => t.ticker),
    );
    const activeSignals = profiles.flatMap((user) =>
      store
        .listUser(user.id, "signal")
        .filter((s) => s.status === "active")
        .map((s) => s.ticker),
    );
    let rows = await prepare(now);
    logMemory("scan:universe-ready");
    const universeStatus = universe.status(now);
    if (!rows.length) {
      state({
        lastScanAt: new Date().toISOString(),
        diagnostics: {
          scanId,
          universeSize: 0,
          dailyReady: false,
          selectedCount: 0,
          evaluatedCount: 0,
          partialData: true,
        },
        marketDiagnostics: { universe: universeStatus },
        error: "מכין נתוני שוק; איתותים חדשים יופיעו אחרי שהמאגר יושלם",
      });
      return;
    }

    const activeStrategies = [
      ...new Set(
        profiles.flatMap((user) =>
          user.settings.strategies.filter((key) => {
            const strategy = STRATEGIES.find((s) => s.key === key);
            return (
              strategy &&
              (user.settings.mode === "both" || user.settings.mode === strategy.mode) &&
              !(user.settings.risk === "balanced" && strategy.risk === "aggressive")
            );
          }),
        ),
      ),
    ];
    const dailyResult = await history.ensureDailyFeatures(rows.map((r) => r.symbol), Date.now());
    logMemory("scan:daily-ready");
    const snap = await snapshots(rows.map((r) => r.symbol));
    const selectionNow = Date.now();
    const picked = selection.selectCandidates({
      rows,
      snapshots: snap,
      dailyFeatures: dailyResult.features,
      rvolScores: history.cachedRvolScores(
        symbolsForSelectionIntradayCache(rows, snap, today, selectionNow),
        calendar, today,
        selectionNow,
      ),
      activeStrategies,
      calendar,
      today,
      now: selectionNow,
    });
    const ranked = picked.selected;
    const streamSymbols = [
      ...new Set([...active, ...activeSignals, ...ranked.map((r) => r.symbol)]),
    ].slice(0, 28);
    watch(streamSymbols);
    const latestSelectedSnapshots = await snapshots(ranked.map((r) => r.symbol));
    for (const row of ranked) {
      const refreshed = latestSelectedSnapshots.get(row.symbol);
      if (refreshed) {
        row.snapshot = refreshed;
        row.price = market.freshPrice(refreshed, Date.now());
      }
    }
    let matches = 0,
      missingData = 0,
      evaluatedCount = 0,
      historyUnavailable = 0;
    const marketCandidates = [];
    const reasonCounts = {};
    const intradaySummary = {
      complete: true,
      cacheHits: 0,
      failedSymbols: [],
      errors: [],
    };
    const personalCounters = new Map(
      profiles.map((user) => [
        user.id,
        {
          strategy_disabled: 0,
          risk_or_mode_filtered: 0,
          excluded: 0,
          duplicate: 0,
          newSignals: 0,
          infeasibleSizing: 0,
        },
      ]),
    );
    for (let batchStart = 0; batchStart < ranked.length; batchStart += INTRADAY_BATCH_SIZE) {
      const batch = ranked.slice(batchStart, batchStart + INTRADAY_BATCH_SIZE);
      const intraday = await history.ensureIntradayBars(batch.map((row) => row.symbol), {
        now: Date.now(),
        keepSymbols: [...active, ...activeSignals],
        evict: batchStart + INTRADAY_BATCH_SIZE >= ranked.length,
      });
      intradaySummary.complete &&= intraday.complete;
      intradaySummary.cacheHits += intraday.cacheHits;
      intradaySummary.failedSymbols.push(...intraday.failedSymbols);
      intradaySummary.errors.push(...intraday.errors);
      const batchSnapshots = await snapshots(batch.map((row) => row.symbol));
      for (const row of batch) {
        const fresh = batchSnapshots.get(row.symbol);
        if (fresh) {
          row.snapshot = fresh;
          row.price = market.freshPrice(fresh, Date.now());
        }
      }

      for (const row of batch) {
        const asOf = Date.now(),
        dailyPack = dailyResult.features.get(row.symbol),
        daily = dailyPack?.features || dailyPack,
        bars = intraday.bars.get(row.symbol) || [];
      if (!daily) {
        missingData++;
        reasonCounts.daily_missing = (reasonCounts.daily_missing || 0) + 1;
        continue;
      }
      if (!bars.length) historyUnavailable++;
      const sessionBars = bars.filter((b) => Date.parse(b.t) >= today.open);
      const prevClose = daily.price;
      const open = sessionBars[0]?.o;
      const gapPct =
        open > 0 && prevClose > 0
          ? ((open - prevClose) / prevClose) * 100
          : null;
      const rvol = market.openingRvol(bars, calendar, today, asOf);
      let detailed = evaluateDetailed({
        daily,
        bars,
        asOf,
        sessionOpen: today.open,
        sessionClose: today.close,
        rvol,
        gapPct,
        hasNews: null,
      });
      const gapResult = detailed.results.get("gap_pullback");
      if (row.eligibleStrategies?.includes("gap_pullback") && gapResult?.reasonCode === "news_needed") {
        let news = store.get("news", row.symbol);
        if (!news || asOf - news.at > 1800000) {
          const count = await finnhub.getRecentNewsCount(row.symbol);
          news = { at: Date.now(), count };
          store.put("news", row.symbol, news);
        }
        detailed = evaluateDetailed({
          daily,
          bars,
          asOf,
          sessionOpen: today.open,
          sessionClose: today.close,
          rvol,
          gapPct,
          hasNews: news.count == null ? "unavailable" : news.count > 0,
        });
      }
      evaluatedCount++;
      for (const [strategyKey, result] of detailed.results) {
        if (!row.eligibleStrategies?.includes(strategyKey)) continue;
        if (!result.matched) {
          reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] || 0) + 1;
          if (["trigger_not_met", "rvol_below_threshold"].includes(result.reasonCode)) {
            marketCandidates.push({
              ticker: row.symbol,
              company: row.companyName,
              exchange: row.exchange,
              strategy: strategyKey,
              reasonCode: result.reasonCode,
              reasonText: selection.reasonText(result.reasonCode),
              observedAt: new Date(asOf).toISOString(),
              priceAt: row.price?.at || market.freshPrice(row.snapshot, asOf)?.at || null,
              dailyFeed: "sip",
              intradayFeed: "iex",
            });
          }
        }
      }
      for (const plan of detailed.plans) {
        if (!row.eligibleStrategies?.includes(plan.strategy)) continue;
        const strategy = STRATEGIES.find((s) => s.key === plan.strategy);
        const endSession =
          strategy.mode === "day"
            ? today
            : calendar.filter((s) => s.open >= today.open)[4];
        if (!endSession || asOf >= today.close - 900000) continue;
        const current = liveQuote(row.symbol, row.snapshot, Date.now());
        if (!current) {
          reasonCounts.live_price_stale = (reasonCounts.live_price_stale || 0) + 1;
          continue;
        }
        if (current.price > plan.maxEntry || current.price < plan.entry) {
          reasonCounts.price_outside_entry = (reasonCounts.price_outside_entry || 0) + 1;
          continue;
        }
        const livePlan = { ...plan, entry: current.price };
        for (const user of profiles) {
          const settings = user.settings;
          const counters = personalCounters.get(user.id);
          if (settings.excludedSymbols.includes(row.symbol)) {
            counters.excluded++;
            continue;
          }
          if (!settings.strategies.includes(strategy.key)) {
            counters.strategy_disabled++;
            continue;
          }
          if (
            (settings.mode !== "both" && settings.mode !== strategy.mode) ||
            (settings.risk === "balanced" && strategy.risk === "aggressive")
          ) {
            counters.risk_or_mode_filtered++;
            continue;
          }
          // One setup per symbol/strategy/session. Stable IDs survive restarts and repeated scans.
          const id = `${today.date}:${row.symbol}:${strategy.key}:${strategy.version}`;
          const duplicate = store
            .listUser(user.id, "signal")
            .some((s) => s.id === id || s.id?.startsWith(`${today.date}:${row.symbol}:${strategy.key}:`));
          if (duplicate) {
            counters.duplicate++;
            continue;
          }
          const signal = {
            ...livePlan,
            id,
            ticker: row.symbol,
            company: row.companyName,
            exchange: row.exchange,
            version: strategy.version,
            mode: strategy.mode,
            evidence: "experimental",
            feed: "iex",
            provenance: {
              dailyFeed: "sip",
              intradayFeed: "iex",
              priceFeed: "iex",
              dailySessionDate: row.lastSessionDate || dailyPack?.lastSessionDate || null,
              priceAt: current.at,
            },
            priceAt: current.at,
            rvol,
            gapPct,
            createdAt: new Date(asOf).toISOString(),
            expiresAt: new Date(
              Math.min(asOf + 600000, today.close - (strategy.origin === "custom_hypothesis" ? 3600000 : 900000)),
            ).toISOString(),
            deadline: new Date(endSession.close - 300000).toISOString(),
            status: "active",
            sizing: config.size(livePlan, settings),
          };
          store.putUser(user.id, "signal", id, signal);
          matches++;
          counters.newSignals++;
          if (!signal.sizing.feasible) counters.infeasibleSizing++;
          if (signal.sizing.feasible && settings.setupComplete)
            notices.event(
              user.id,
              `signal:${id}`,
              `${row.symbol} · ${strategy.label}`,
              `איתות ניסיוני: כניסה $${plan.entry.toFixed(2)}–$${plan.maxEntry.toFixed(2)}. תוקף עד 10 דקות; בדוק זמינות ב־Blink.`,
              "signal",
            );
        }
      }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    logMemory("scan:intraday-ready");
    const freshCandidates = marketCandidates.filter(
      (candidate, index, list) =>
        list.findIndex((item) => item.ticker === candidate.ticker && item.strategy === candidate.strategy) === index,
    );
    for (const user of profiles) {
      const personal = freshCandidates
        .filter((candidate) => {
          const settings = user.settings;
          const strategy = STRATEGIES.find((item) => item.key === candidate.strategy);
          return (
            strategy &&
            !settings.excludedSymbols.includes(candidate.ticker) &&
            settings.strategies.includes(candidate.strategy) &&
            (settings.mode === "both" || settings.mode === strategy.mode) &&
            !(settings.risk === "balanced" && strategy.risk === "aggressive")
          );
        })
        .slice(0, 20);
      store.putUser(user.id, "candidate", "latest", {
        scanId,
        date: today.date,
        observedAt: new Date().toISOString(),
        rows: personal,
        counters: personalCounters.get(user.id),
      });
    }
    state({
      lastScanAt: new Date().toISOString(),
      diagnostics: {
        scanId,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        universe: rows.length,
        universeSize: rows.length,
        dailyReady: dailyResult.features.size,
        snapshotAvailable: snap.size,
        freshPriceCount: picked.selected.filter((row) => row.price).length,
        live: ranked.length,
        selectedCount: ranked.length,
        evaluatedCount,
        historyUnavailable,
        cacheHits: dailyResult.cacheHits + intradaySummary.cacheHits,
        requestsByProvider: { alpaca: "batched", finnhub: "gap-only" },
        partialData:
          !dailyResult.complete ||
          !intradaySummary.complete ||
          universeStatus.diagnostics?.partialData,
        missingData,
        reasonCounts,
      },
      personalDiagnostics: Object.fromEntries(personalCounters),
      marketDiagnostics: {
        universe: universe.status(now),
        selection: picked.diagnostics,
      },
      matches: undefined,
      error: null,
    });
  } finally {
    scanRunning = false;
    state({ scanning: false });
  }
}
async function monitor(now) {
  const profiles = users.all().map((u) => ({ id: u.id }));
  const rows = profiles.map((user) => ({
    ...user,
    signals: store
      .listUser(user.id, "signal")
      .filter((s) => s.status === "active"),
    trades: store
      .listUser(user.id, "trade")
      .filter((t) => t.status === "open"),
  }));
  const signals = rows.flatMap((r) => r.signals);
  const trades = rows.flatMap((r) => r.trades);
  const symbols = [
    ...new Set([
      ...signals.map((s) => s.ticker),
      ...trades.map((t) => t.ticker),
    ]),
  ];
  if (!symbols.length) return;
  const snap = await snapshots(symbols);
  for (const user of rows) {
    for (const signal of user.signals) {
      const q = liveQuote(signal.ticker, snap.get(signal.ticker), Date.now());
      if (now >= Date.parse(signal.expiresAt))
        store.putUser(user.id, "signal", signal.id, {
          ...signal,
          status: "expired",
        });
      else if (q && (q.price <= signal.stop || q.price > signal.maxEntry))
        store.putUser(user.id, "signal", signal.id, {
          ...signal,
          status: "invalidated",
        });
      else if (q) {
        store.putUser(user.id, "signal", signal.id, { ...signal, priceAt: q.at });
        if (config.read(user.id).enabled)
          tracking.simulate(user.id, signal, q, Date.now());
      }
    }
    for (const trade of user.trades) {
      const start = trade.lastCheckedAt || trade.enteredAt;
      const bars = await alpaca.getIntradayBars({
        symbols: [trade.ticker],
        timeframe: "5Min",
        start,
        end: new Date(now).toISOString(),
      });
      tracking.track(
        user.id,
        trade,
        bars.get(trade.ticker) || [],
        liveQuote(trade.ticker, snap.get(trade.ticker), now),
        now,
      );
    }
  }
}
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now(),
      profiles = users.all().map((u) => ({
        id: u.id,
        settings: config.read(u.id),
      })),
      anyEnabled = profiles.some((u) => u.settings.enabled);
    state({
      heartbeatAt: new Date(now).toISOString(),
      enabled: anyEnabled,
      stream: streamStatus,
      configured: alpaca.isConfigured(),
    });
    if (!alpaca.isConfigured()) {
      state({ error: "מפתחות נתוני השוק אינם מוגדרים בשרת" });
      return;
    }
    const calendar = await market.sessions(now),
      clock = await alpaca.getClock();
    if (!clock || typeof clock.is_open !== "boolean")
      throw new Error("שעון השוק אינו זמין; יצירת איתותים הושהתה");
    const today = calendar.find((s) => s.date === market.nyDate(now));
    state({
      marketOpen: clock.is_open,
      nextOpen: clock.next_open,
      session: today || null,
      error: null,
    });
    if (clock.is_open && streamKey) watch(streamKey.split(","));
    await monitor(now);
    if (
      anyEnabled &&
      today &&
      now >= today.open - 3600000 &&
      now < today.open &&
      !scanRunning
    )
      prepare(now).catch((e) => state({ error: e.message }));
    if (
      anyEnabled &&
      clock.is_open &&
      today &&
      now >= today.open + 900000 &&
      now < today.close - 900000 &&
      !scanRunning &&
      store.lease("scan", 300000, now)
    ) {
      scan(now, calendar, today).catch((e) => state({ error: e.message }));
    }
    if (!clock.is_open && socket) {
      socket.close();
      socket = null;
      streamKey = "";
    }
    if (today && now > today.close + 900000) {
      for (const user of profiles) {
        if (!store.lease(`report:${user.id}:${today.date}`, 86400000, now))
          continue;
        const trades = store.listUser(user.id, "trade");
        const stats = tracking.statistics(trades);
        notices.event(
          user.id,
          `report:${today.date}`,
          "סיכום יום המסחר",
          `מעקבים פתוחים: ${trades.filter((t) => t.status === "open").length}. ${stats[0].n} עסקאות סימולטיביות סגורות בסך הכול.`,
          "report",
        );
      }
    }
  } catch (error) {
    state({ error: error.message });
    for (const user of users.all())
      notices.event(
        user.id,
        `engine-error:${market.nyDate()}`,
        "המעקב דורש בדיקה",
        "שירות נתוני השוק אינו זמין. פתח את המערכת ובדוק עסקאות פתוחות ב־Blink.",
        "warning",
      );
  } finally {
    try {
      await notices.flush();
    } catch (error) {
      state({ notificationError: error.message });
    }
    running = false;
  }
}
function start() {
  if (timer || process.env.AUTOPILOT_DISABLED === "true") return;
  state({ startedAt: new Date().toISOString(), scanning: false });
  tick();
  timer = setInterval(tick, 30000);
  timer.unref();
}
function stop() {
  clearInterval(timer);
  timer = null;
  if (socket) socket.close();
}
function requestScan() {
  store.remove("lease", "scan");
  tick();
}
module.exports = { start, stop, tick, requestScan, scan, monitor };

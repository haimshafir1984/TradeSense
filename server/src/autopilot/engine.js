const store = require("./store");
const config = require("./settings");
const market = require("./market");
const { STRATEGIES, evaluate } = require("./strategies");
const tracking = require("./tracking");
const notices = require("./notifications");
const alpaca = require("../providers/alpacaService");
const finnhub = require("../providers/finnhubService");
const universe = require("../services/universeBuilderService");
const { computeFeaturesFromBars } = require("../playbooks/features");
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
  const date = market.nyDate(now);
  const cache = store.get("cache", "universe");
  if (cache?.date === date && cache.rows.length) return cache.rows;
  if (Date.now() - lastUniverseAttempt < 300000) return cache?.rows || [];
  lastUniverseAttempt = Date.now();
  const rows = [];
  for (const exchange of ["NASDAQ", "NYSE"]) {
    const data = await universe.getUniverseWithLazyRefresh(exchange);
    for (const row of data?.rows || [])
      if (/^[A-Z]{1,5}$/.test(row.symbol)) rows.push({ ...row, exchange });
  }
  if (rows.length) store.put("cache", "universe", { date, rows });
  return rows;
}
async function dailyFeatures(symbols, now) {
  const date = market.nyDate(now),
    result = new Map();
  const missing = [];
  for (const symbol of symbols) {
    const cached = store.get("daily", symbol);
    if (cached?.date === date) result.set(symbol, cached.features);
    else missing.push(symbol);
  }
  if (missing.length) {
    const bars = await alpaca.getDailyBars({ symbols: missing, days: 420 });
    for (const symbol of missing) {
      const closed = (bars.get(symbol) || []).filter(
        (b) => market.nyDate(Date.parse(b.t)) < date,
      );
      if (closed.length < 200) continue;
      const features = computeFeaturesFromBars(closed);
      store.put("daily", symbol, { date, features });
      result.set(symbol, features);
    }
  }
  return result;
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
async function scan(now, calendar, today) {
  if (scanRunning) return;
  scanRunning = true;
  state({ scanning: true });
  try {
    const settings = config.read(),
      rows = await prepare(now);
    const snap = await snapshots(rows.map((r) => r.symbol));
    const ranked = rows
      .filter((r) => !settings.excludedSymbols.includes(r.symbol))
      .map((row) => {
        const s = snap.get(row.symbol),
          price = market.freshPrice(s, Date.now());
        const sameDay =
          market.nyDate(Date.parse(s?.dailyBar?.t || 0)) === today.date;
        return {
          ...row,
          snapshot: s,
          price,
          activity: sameDay
            ? Number(s?.dailyBar?.v) * Number(s?.dailyBar?.c)
            : 0,
        };
      })
      .filter((r) => r.price && r.price.price >= 5 && r.activity > 0)
      .sort((a, b) => b.activity - a.activity)
      .slice(0, 25);
    const active = store
      .list("trade")
      .filter((t) => t.status === "open")
      .map((t) => t.ticker);
    const selected = [
      ...new Set([...active, ...ranked.map((r) => r.symbol)]),
    ].slice(0, 28);
    watch(selected);
    const features = await dailyFeatures(
      ranked.map((r) => r.symbol),
      now,
    );
    const history = await alpaca.getIntradayBars({
      symbols: ranked.map((r) => r.symbol),
      timeframe: "5Min",
      start: new Date(now - 26 * 86400000).toISOString(),
      end: new Date().toISOString(),
    });
    let matches = 0,
      missingData = 0;
    for (const row of ranked) {
      const asOf = Date.now(),
        daily = features.get(row.symbol),
        bars = history.get(row.symbol) || [];
      if (!daily) {
        missingData++;
        continue;
      }
      let news = store.get("news", row.symbol);
      if (!news || asOf - news.at > 1800000) {
        const count = await finnhub.getRecentNewsCount(row.symbol);
        news = { at: Date.now(), count };
        store.put("news", row.symbol, news);
      }
      const sessionBars = bars.filter((b) => Date.parse(b.t) >= today.open);
      const prevClose = daily.price;
      const open = sessionBars[0]?.o;
      const gapPct =
        open > 0 && prevClose > 0
          ? ((open - prevClose) / prevClose) * 100
          : null;
      const rvol = market.openingRvol(bars, calendar, today, asOf);
      for (const plan of evaluate({
        daily,
        bars,
        asOf,
        sessionOpen: today.open,
        sessionClose: today.close,
        rvol,
        gapPct,
        hasNews: news.count > 0,
      })) {
        if (!config.read().enabled) return;
        const strategy = STRATEGIES.find((s) => s.key === plan.strategy);
        if (
          !settings.strategies.includes(strategy.key) ||
          (settings.mode !== "both" && settings.mode !== strategy.mode) ||
          (settings.risk === "balanced" && strategy.risk === "aggressive")
        )
          continue;
        if (asOf >= today.close - 900000) continue;
        // One setup per symbol/strategy/session. Stable IDs survive restarts and repeated scans.
        const id = `${today.date}:${row.symbol}:${strategy.key}:${strategy.version}`;
        if (store.get("signal", id)) continue;
        const endSession =
          strategy.mode === "day"
            ? today
            : calendar.filter((s) => s.open >= today.open)[4];
        if (!endSession) continue;
        const current = liveQuote(row.symbol, row.snapshot, Date.now());
        if (
          !current ||
          current.price > plan.maxEntry ||
          current.price < plan.entry
        )
          continue;
        const livePlan = { ...plan, entry: current.price };
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
          priceAt: current.at,
          rvol,
          gapPct,
          createdAt: new Date(asOf).toISOString(),
          expiresAt: new Date(
            Math.min(asOf + 600000, today.close - 900000),
          ).toISOString(),
          deadline: new Date(endSession.close - 300000).toISOString(),
          status: "active",
          sizing: config.size(livePlan, settings),
        };
        store.put("signal", id, signal);
        matches++;
        if (signal.sizing.feasible && settings.setupComplete)
          notices.event(
            `signal:${id}`,
            `${row.symbol} · ${strategy.label}`,
            `איתות ניסיוני: כניסה $${plan.entry.toFixed(2)}–$${plan.maxEntry.toFixed(2)}. תוקף עד 10 דקות; בדוק זמינות ב־Blink.`,
            "signal",
          );
      }
    }
    state({
      lastScanAt: new Date().toISOString(),
      diagnostics: {
        universe: rows.length,
        live: ranked.length,
        missingData,
        matches,
      },
      error: null,
    });
  } finally {
    scanRunning = false;
    state({ scanning: false });
  }
}
async function monitor(now) {
  const signals = store.list("signal").filter((s) => s.status === "active");
  const trades = store.list("trade").filter((t) => t.status === "open");
  const symbols = [
    ...new Set([
      ...signals.map((s) => s.ticker),
      ...trades.map((t) => t.ticker),
    ]),
  ];
  if (!symbols.length) return;
  const snap = await snapshots(symbols);
  for (const signal of signals) {
    const q = liveQuote(signal.ticker, snap.get(signal.ticker), Date.now());
    if (now >= Date.parse(signal.expiresAt))
      store.put("signal", signal.id, { ...signal, status: "expired" });
    else if (q && (q.price <= signal.stop || q.price > signal.maxEntry))
      store.put("signal", signal.id, { ...signal, status: "invalidated" });
    else if (q) {
      store.put("signal", signal.id, { ...signal, priceAt: q.at });
      if (config.read().enabled) tracking.simulate(signal, q, Date.now());
    }
  }
  for (const trade of trades) {
    const start = trade.lastCheckedAt || trade.enteredAt;
    const bars = await alpaca.getIntradayBars({
      symbols: [trade.ticker],
      timeframe: "5Min",
      start,
      end: new Date(now).toISOString(),
    });
    tracking.track(
      trade,
      bars.get(trade.ticker) || [],
      liveQuote(trade.ticker, snap.get(trade.ticker), now),
      now,
    );
  }
}
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now(),
      settings = config.read();
    state({
      heartbeatAt: new Date(now).toISOString(),
      enabled: settings.enabled,
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
      settings.enabled &&
      today &&
      now >= today.open - 3600000 &&
      now < today.open &&
      !scanRunning
    )
      prepare(now).catch((e) => state({ error: e.message }));
    if (
      settings.enabled &&
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
    if (
      today &&
      now > today.close + 900000 &&
      store.lease(`report:${today.date}`, 86400000, now)
    ) {
      const stats = tracking.statistics(store.list("trade"));
      notices.event(
        `report:${today.date}`,
        "סיכום יום המסחר",
        `מעקבים פתוחים: ${store.list("trade").filter((t) => t.status === "open").length}. ${stats[0].n} עסקאות סימולטיביות סגורות בסך הכול.`,
        "report",
      );
    }
  } catch (error) {
    state({ error: error.message });
    notices.event(
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
  if (process.env.NODE_ENV === "production" && !process.env.APP_ACCESS_TOKEN) {
    state({ error: "נדרש APP_ACCESS_TOKEN להפעלה מוגנת בשרת" });
    return;
  }
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

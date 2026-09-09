const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-v3-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.PORTFOLIO_STORE_FILE_PATH = path.join(scratch, "portfolio.json");
const store = require("../src/autopilot/store");
const config = require("../src/autopilot/settings");
const market = require("../src/autopilot/market");
const strategy = require("../src/autopilot/strategies");
const selection = require("../src/autopilot/selection");
const tracking = require("../src/autopilot/tracking");
const autopilotHistory = require("../src/autopilot/history");
const alpaca = require("../src/providers/alpacaService");
const notices = require("../src/autopilot/notifications");
const users = require("../src/autopilot/users");
const USER = "unit-user";
test.after(() => {
  store.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const start = Date.parse("2026-09-08T13:30:00Z");
const iso = (t) => new Date(t).toISOString();
const bar = (i, extras = {}) => ({
  t: iso(start + i * 300000),
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 100,
  vw: 100,
  ...extras,
});
const signal = (id) => ({
  id,
  ticker: "TEST",
  strategy: "orb15",
  version: "3.0.0",
  entry: 100,
  maxEntry: 101,
  stop: 98,
  target: 104,
  createdAt: iso(start),
  expiresAt: iso(start + 600000),
  deadline: iso(start + 3600000),
  mode: "day",
  sizing: { feasible: true },
});

test("Blink paid fee handles fractional small orders and minimum", () => {
  assert.equal(config.fee(0.7, 100), 1.26);
  assert.equal(config.fee(1, 100), 1.5);
  assert.equal(config.fee(200, 100), 2);
  assert.equal(config.fee(1, 100, "free"), 0);
});
test("sizing respects cash plus entry fee and total stop risk", () => {
  const s = { ...config.DEFAULTS, equity: 100, availableCash: 100 };
  const size = config.size(signal("size"), s);
  assert.ok(size.cost <= 30);
  assert.ok(size.riskUsd <= 0.5);
  assert.equal(
    config.size(signal("size"), { ...s, fractional: false }).feasible,
    false,
  );
  assert.ok(config.size(signal("size"), s, 99.9).cost <= 0.1);
  assert.equal(
    config.size({ ...signal("size"), target: 100.01 }, s).feasible,
    false,
  );
});
test("invalid settings cannot enable unsupported strategies or excessive risk", () => {
  assert.throws(() => config.save({ riskPct: 20 }, USER));
  assert.throws(() => config.save({ enabled: "yes" }, USER));
  assert.throws(() => config.save({ strategies: ["madeup"] }, USER));
});
test("first login creates a separate profile even with a simple code", () => {
  const first = users.session({ code: "1234" });
  const second = users.session({ code: "1234" });
  assert.notEqual(first.userId, second.userId);
  assert.equal(users.session({ userId: first.userId, code: "1234" }).userId, first.userId);
  assert.throws(() => users.session({ userId: first.userId, code: "4321" }));
});
test("market timestamps follow New York DST, and stale prices fail closed", () => {
  assert.equal(
    iso(market.nyTimestamp("2026-01-05", "09:30")),
    "2026-01-05T14:30:00.000Z",
  );
  assert.equal(
    iso(market.nyTimestamp("2026-09-08", "09:30")),
    "2026-09-08T13:30:00.000Z",
  );
  assert.equal(market.freshPrice({ dailyBar: { c: 100 } }, start), null);
  assert.equal(
    market.freshPrice(
      { latestTrade: { p: 100, t: iso(start - 91000) } },
      start,
    ),
    null,
  );
  assert.equal(
    market.freshPrice({ latestTrade: { p: 100, t: iso(start + 5000) } }, start),
    null,
  );
  assert.equal(
    market.freshPrice({ latestTrade: { p: 100, t: iso(start) } }, start).price,
    100,
  );
});
test("opening breakout uses closed bars only and requires complete opening range", () => {
  const bars = [bar(0), bar(1), bar(2), bar(3, { c: 102, h: 103 })];
  const args = {
    daily: { atr14: 2 },
    bars,
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
  };
  assert.equal(strategy.evaluate(args)[0].strategy, "orb15");
  assert.deepEqual(strategy.evaluate({ ...args, asOf: start + 1199999 }), []);
  assert.deepEqual(strategy.evaluate({ ...args, bars: bars.slice(1) }), []);
  assert.deepEqual(strategy.evaluate({ ...args, rvol: null }), []);
  assert.equal(strategy.vwap([{ v: 100, c: 100 }]), null);
});
test("day strategies can be diagnosed with ATR even when MA200 is unavailable", () => {
  const bars = [bar(0), bar(1), bar(2), bar(3, { c: 100.5, h: 101 })];
  const detailed = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2, ma200: null },
    bars,
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 1.1,
    gapPct: null,
    hasNews: null,
  });
  assert.equal(detailed.results.get("orb15").reasonCode, "rvol_below_threshold");
  assert.equal(detailed.results.get("reversal5").reasonCode, "daily_missing");
});
test("gap pullback asks for news only after the price trigger is otherwise ready", () => {
  const notTriggered = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2 },
    bars: [bar(0), bar(1), bar(2), bar(3, { c: 101, h: 102 })],
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
    gapPct: 4,
    hasNews: null,
  });
  assert.equal(notTriggered.results.get("gap_pullback").reasonCode, "trigger_not_met");

  const readyForNews = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2 },
    bars: [
      bar(0, { o: 103, c: 104, h: 104, l: 102 }),
      bar(1, { o: 104, c: 105, h: 105, l: 103 }),
      bar(2, { o: 105, c: 104, h: 106, l: 103 }),
      bar(3, { o: 104, c: 107, h: 108, l: 104 }),
    ],
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
    gapPct: 4,
    hasNews: null,
  });
  assert.equal(readyForNews.results.get("gap_pullback").reasonCode, "news_needed");
});
test("selection uses strategy lists, dedupes symbols, and rotates beyond the top activity names", () => {
  store.remove("runtime", "selection-cursor");
  const now = start + 1200000;
  const today = { date: market.nyDate(now), open: start, close: start + 23400000 };
  const rows = Array.from({ length: 30 }, (_, index) => ({
    symbol: `S${index}`,
    companyName: `Symbol ${index}`,
    exchange: "NASDAQ",
    close: index === 29 ? 10 : 100,
    avgDollarVolume20d: 2_000_000 + index,
  }));
  const snapshots = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        dailyBar: {
          t: iso(now),
          o: index === 29 ? 10.5 : 100,
          c: index === 29 ? 10.8 : 101 + index,
          v: 1000 + index,
        },
        latestTrade: { p: index === 29 ? 10.8 : 101 + index, t: iso(now) },
      },
    ]),
  );
  const dailyFeatures = new Map(
    rows.map((row) => [row.symbol, { features: { price: row.close, atr14: 2 } }]),
  );
  const picked = selection.selectCandidates({
    rows,
    snapshots,
    dailyFeatures,
    activeStrategies: ["orb15", "gap_pullback"],
    calendar: [today],
    today,
    now,
  });
  assert.ok(picked.selected.length <= 120);
  assert.ok(picked.selected.some((item) => item.symbol === "S29"));
  assert.ok(picked.diagnostics.listSizes.gap_pullback >= 1);
});
test("VWAP selection ranks cached comparable IEX volume before plain activity", () => {
  store.remove("runtime", "selection-cursor");
  const now = start + 1200000;
  const today = { date: market.nyDate(now), open: start, close: start + 23400000 };
  const calendar = Array.from({ length: 6 }, (_, i) => ({
    date: market.nyDate(start - (5 - i) * 86400000),
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const rows = [
    { symbol: "LOWRV", companyName: "Low RVOL", exchange: "NASDAQ", close: 100 },
    { symbol: "HIGHRV", companyName: "High RVOL", exchange: "NASDAQ", close: 100 },
  ];
  const snapshots = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        dailyBar: { t: iso(now), o: 100, c: 101, v: index === 0 ? 5000 : 1000 },
        latestTrade: { p: 101, t: iso(now) },
      },
    ]),
  );
  const dailyFeatures = new Map(rows.map((row) => [row.symbol, { features: { price: row.close, atr14: 2 } }]));
  const historyBars = (todayVolume) =>
    calendar.flatMap((session, index) =>
      Array.from({ length: 4 }, (_, k) => ({
        ...bar(k),
        t: iso(session.open + k * 300000),
        v: index === 5 ? todayVolume : 100,
      })),
    );
  const intradayCache = new Map([
    ["LOWRV", historyBars(110)],
    ["HIGHRV", historyBars(300)],
  ]);

  const picked = selection.selectCandidates({
    rows,
    snapshots,
    dailyFeatures,
    intradayCache,
    activeStrategies: ["vwap_reclaim"],
    calendar,
    today,
    now,
  });

  assert.equal(picked.lists.vwap_reclaim[0].symbol, "HIGHRV");
  assert.equal(picked.selected[0].symbol, "HIGHRV");
});
test("relative volume compares matching elapsed time and ignores future volume", () => {
  const days = Array.from({ length: 6 }, (_, i) => ({
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const bars = days.flatMap((s, i) =>
    Array.from({ length: 4 }, (_, k) => ({
      ...bar(k),
      t: iso(s.open + k * 300000),
      v: i === 5 ? 200 : 100,
    })),
  );
  bars.push({ ...bar(5), v: 100000 });
  assert.equal(market.openingRvol(bars, days, days[5], start + 1200000), 2);
  assert.equal(
    market.openingRvol(bars.slice(1), days, days[5], start + 1200000),
    null,
  );
});
test("partial daily history does not cache failed symbols as usable features", async (t) => {
  const symbol = "PART";
  const now = start + 1200000;
  store.remove("history", autopilotHistory.cacheKey({ symbol, feed: "sip", timeframe: "1Day" }));
  t.mock.method(alpaca, "getBarsDetailed", async () => ({
    bars: new Map([
      [
        symbol,
        Array.from({ length: 20 }, (_, index) => ({
          t: iso(start - (20 - index) * 86400000),
          o: 10,
          h: 11,
          l: 9,
          c: 10,
          v: 1000,
        })),
      ],
    ]),
    complete: false,
    failedSymbols: [symbol],
    errors: [{ status: 429, kind: "rate_limit" }],
  }));

  const result = await autopilotHistory.ensureDailyFeatures([symbol], now);

  assert.equal(result.complete, false);
  assert.equal(result.features.has(symbol), false);
  assert.equal(store.get("history", autopilotHistory.cacheKey({ symbol, feed: "sip", timeframe: "1Day" })), null);
});
test("intraday history refreshes fully on a new session and does not mix old split-adjusted bars", async (t) => {
  const symbol = "SPLT";
  const previousDay = Date.parse("2026-09-08T15:00:00Z");
  const nextDay = Date.parse("2026-09-09T15:00:00Z");
  const key = autopilotHistory.cacheKey({ symbol, feed: "iex", timeframe: "5Min" });
  store.put("history", key, {
    symbol,
    feed: "iex",
    timeframe: "5Min",
    adjustment: "split",
    schema: "v1",
    bars: [{ ...bar(0), t: iso(previousDay), c: 200 }],
    watermarkAt: iso(previousDay + 300000),
    lastBarAt: iso(previousDay),
    fetchedAt: iso(previousDay),
    lastUsedAt: iso(previousDay),
    sessionDate: market.nyDate(previousDay),
  });
  let capturedStart = null;
  t.mock.method(alpaca, "getBarsDetailed", async ({ start }) => {
    capturedStart = start;
    return {
      bars: new Map([[symbol, [{ ...bar(0), t: iso(nextDay), c: 100 }]]]),
      complete: true,
      failedSymbols: [],
      errors: [],
    };
  });

  const result = await autopilotHistory.ensureIntradayBars([symbol], { now: nextDay, keepSymbols: [] });

  assert.ok(Date.parse(capturedStart) <= nextDay - 26 * 86400000 + 1000);
  assert.deepEqual(result.bars.get(symbol).map((item) => item.c), [100]);
  assert.equal(store.get("history", key).sessionDate, market.nyDate(nextDay));
});
test("persisted lease and transaction survive reopen without duplicate run", () => {
  assert.equal(store.lease("test", 1000, start), true);
  store.close();
  assert.equal(store.lease("test", 1000, start + 100), false);
  assert.throws(() =>
    store.transaction(() => {
      store.put("rollback", "x", { a: 1 });
      throw Error("rollback");
    }),
  );
  assert.equal(store.get("rollback", "x"), null);
});
test("simulation cannot enter before signal and cannot reuse entry candle", () => {
  config.save({ fees: "free", slippagePct: 0 }, USER);
  const s = signal("simulation");
  tracking.simulate(USER, s, { price: 100, at: s.createdAt }, start);
  assert.equal(store.getUser(USER, "trade", "sim:simulation"), null);
  tracking.simulate(USER, s, { price: 100, at: iso(start + 30000) }, start + 30000);
  let trade = store.getUser(USER, "trade", "sim:simulation");
  assert.ok(trade);
  tracking.simulate(USER, s, { price: 100, at: iso(start + 40000) }, start + 40000);
  assert.equal(store.listUser(USER, "trade").filter((t) => t.id === trade.id).length, 1);
  trade = tracking.track(
    USER,
    trade,
    [bar(0, { l: 90, h: 110 })],
    null,
    start + 300000,
  );
  assert.equal(trade.status, "open");
  trade = tracking.track(
    USER,
    trade,
    [bar(1, { o: 95, l: 94, h: 110 })],
    null,
    start + 600000,
  );
  assert.equal(trade.exit, 95);
  assert.equal(trade.exitReason, "stop");
});
test("personal stop alert never sells; actual fills and late reports are distinct", () => {
  const s = signal("personal");
  store.putUser(USER, "signal", s.id, s);
  assert.throws(() =>
    tracking.personalEntry(
      USER,
      s.id,
      { price: 100, shares: 1, executedAt: iso(start - 1000) },
      start + 60000,
    ),
  );
  let trade = tracking.personalEntry(
    USER,
    s.id,
    { price: 100, shares: 0.2, fees: 0, executedAt: iso(start + 1000) },
    start + 60000,
  );
  assert.equal(trade.enteredAt, iso(start + 1000));
  trade = tracking.track(
    USER,
    trade,
    [],
    { price: 97, at: iso(start + 120000) },
    start + 120000,
  );
  assert.equal(trade.status, "open");
  assert.equal(trade.exitAlert, "stop");
  assert.throws(() =>
    tracking.personalClose(
      USER,
      trade.id,
      { price: 98, executedAt: iso(start) },
      start + 180000,
    ),
  );
  trade = tracking.personalClose(
    USER,
    trade.id,
    { price: 98, fees: 0.1 },
    start + 180000,
  );
  assert.equal(trade.pnl, -0.5);
  const stats = tracking.statistics(store.listUser(USER, "trade"));
  assert.equal(stats.find((s) => s.source === "personal").n, 1);
});
test("time exit uses final completed bar even if no fresh quote remains", () => {
  const trade = {
    ...signal("timed"),
    source: "simulation",
    status: "open",
    shares: 1,
    entryFee: 0,
    feeMode: "free",
    enteredAt: iso(start),
    lastCheckedAt: iso(start),
    deadline: iso(start + 600000),
  };
  const result = tracking.track(
    USER,
    trade,
    [bar(0), bar(1, { c: 101 })],
    null,
    start + 900000,
  );
  assert.equal(result.exitReason, "time");
  assert.equal(result.exit, 101);
  assert.equal(result.closedAt, trade.deadline);
});
test("scheduler monitors an existing position with no browser requests", async () => {
  const engine = require("../src/autopilot/engine");
  const originals = {
    isConfigured: alpaca.isConfigured,
    getClock: alpaca.getClock,
    getCalendar: alpaca.getCalendar,
    getSnapshots: alpaca.getSnapshots,
    getIntradayBars: alpaca.getIntradayBars,
    flush: notices.flush,
  };
  try {
    users.session({ userId: "scheduler-user", code: "1234" });
    config.save({ enabled: false }, "scheduler-user");
    const now = Date.now();
    const date = market.nyDate(now);
    const trade = {
      ...signal("background"),
      id: "background",
      source: "personal",
      status: "open",
      shares: 1,
      entryFee: 0,
      feeMode: "free",
      enteredAt: iso(now - 600000),
      lastCheckedAt: iso(now - 600000),
      deadline: iso(now + 3600000),
    };
    store.putUser("scheduler-user", "trade", trade.id, trade);
    alpaca.isConfigured = () => true;
    alpaca.getClock = async () => ({
      is_open: false,
      next_open: iso(now + 86400000),
    });
    alpaca.getCalendar = async () => [{ date, open: "09:30", close: "16:00" }];
    alpaca.getSnapshots = async () =>
      new Map([["TEST", { latestTrade: { p: 97, t: iso(now) } }]]);
    alpaca.getIntradayBars = async () => new Map();
    notices.flush = async () => {};
    await engine.tick();
    assert.equal(store.getUser("scheduler-user", "trade", trade.id).exitAlert, "stop");
    assert.ok(store.get("runtime", "engine").heartbeatAt);
  } finally {
    Object.assign(alpaca, { ...originals });
    notices.flush = originals.flush;
  }
});
test("full scan produces a fresh priced signal and deduplicates repeated scans", async (t) => {
  const engine = require("../src/autopilot/engine");
  const now = start + 1200000;
  t.mock.method(Date, "now", () => now);
  users.session({ userId: "scan-user", code: "1234" });
  config.save({ enabled: true, fees: "free" }, "scan-user");
  const calendar = Array.from({ length: 6 }, (_, i) => ({
    date: market.nyDate(start - (5 - i) * 86400000),
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const today = calendar.at(-1);
  store.put("cache", "universe", {
    date: today.date,
    rows: [{ symbol: "SCAN", exchange: "NASDAQ" }],
  });
  store.put("cache", "v3-universe", {
    date: today.date,
    rows: [
      {
        symbol: "SCAN",
        companyName: "Scan Corp",
        exchange: "NASDAQ",
        close: 100,
        avgDollarVolume20d: 5_000_000,
        dailyFeed: "sip",
        lastSessionDate: market.nyDate(start - 86400000),
      },
    ],
    diagnostics: { complete: true },
  });
  const dailyBars = Array.from({ length: 20 }, (_, index) => ({
    t: iso(start - (20 - index) * 86400000),
    o: 100,
    h: 102,
    l: 98,
    c: 100,
    v: 1000,
  }));
  store.put("history", autopilotHistory.cacheKey({ symbol: "SCAN", feed: "sip", timeframe: "1Day" }), {
    symbol: "SCAN",
    feed: "sip",
    timeframe: "1Day",
    adjustment: "split",
    schema: "v1",
    bars: dailyBars,
    lastSessionDate: market.nyDate(start - 86400000),
    fetchedAt: iso(now),
  });
  store.put("news", "SCAN", { at: now, count: 0 });
  const bars = calendar.flatMap((session, i) =>
    Array.from({ length: 4 }, (_, k) => ({
      ...bar(k, i === 5 && k === 3 ? { c: 102, h: 103 } : {}),
      t: iso(session.open + k * 300000),
      v: i === 5 ? 200 : 100,
    })),
  );
  t.mock.method(
    alpaca,
    "getSnapshots",
    async () =>
      new Map([
        [
          "SCAN",
          {
            dailyBar: { t: iso(start), v: 800, c: 102 },
            latestTrade: { p: 102, t: iso(now) },
          },
        ],
      ]),
  );
  t.mock.method(
    alpaca,
    "getBarsDetailed",
    async ({ timeframe }) =>
      timeframe === "5Min"
        ? { bars: new Map([["SCAN", bars]]), complete: true, failedSymbols: [], errors: [] }
        : { bars: new Map([["SCAN", dailyBars]]), complete: true, failedSymbols: [], errors: [] },
  );
  t.mock.method(alpaca, "openStream", () => ({ readyState: 1, close() {} }));
  try {
    await engine.scan(now, calendar, today);
    const rows = store.listUser("scan-user", "signal").filter((s) => s.ticker === "SCAN");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entry, 102);
    assert.equal(rows[0].strategy, "orb15");
    assert.equal(rows[0].status, "active");
    await engine.scan(now, calendar, today);
    assert.equal(
      store.listUser("scan-user", "signal").filter((s) => s.ticker === "SCAN").length,
      1,
    );
  } finally {
    engine.stop();
  }
});

test("production API creates a browser profile and rejects unauthorized writes", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/autopilot`;
  try {
    assert.equal((await fetch(`${url}/dashboard`)).status, 401);
    const session = await (
      await fetch(`${url}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "1234" }),
      })
    ).json();
    assert.ok(session.userId);
    assert.equal(
      (
        await fetch(`${url}/dashboard`, {
          headers: {
            Authorization: "Bearer 1234",
            "X-TradeSense-User": session.userId,
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${url}/settings`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer 1234",
            "X-TradeSense-User": session.userId,
            Origin: "https://wrong.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((r) => server.close(r));
    if (oldEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnv;
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function setup() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-alpaca-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
  for (const m of ["store", "settings", "risk", "broker", "entry", "exit", "universe"]) {
    const file = m === "store" ? "../src/autopilot/store" : `../src/alpaca-trader/${m}`;
    delete require.cache[require.resolve(file)];
  }
  delete require.cache[require.resolve("../src/providers/alpacaService")];
  const store = require("../src/autopilot/store");
  const settings = require("../src/alpaca-trader/settings");
  const risk = require("../src/alpaca-trader/risk");
  const broker = require("../src/alpaca-trader/broker");
  const entry = require("../src/alpaca-trader/entry");
  const exitManager = require("../src/alpaca-trader/exit");
  const universe = require("../src/alpaca-trader/universe");
  const alpacaService = require("../src/providers/alpacaService");
  return {
    store, settings, risk, broker, entry, exitManager, universe, alpacaService,
    cleanup() {
      store.close();
      delete process.env.AUTOPILOT_DB_PATH;
      delete process.env.ALPACA_TRADER_MEMORY_GUARD_MB;
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test("settings: defaults match the agreed table, and validation rejects bad input", () => {
  const { settings, cleanup } = setup();
  try {
    const d = settings.read();
    assert.equal(d.totalExposurePct, 60);
    assert.equal(d.maxRiskPct, 4);
    assert.equal(d.minShares, 1, "no Colmex lot minimum carries over here");
    assert.deepEqual(d.strategies, ["orb15", "orb15_retest", "vwap_reclaim", "vwap_pullback", "reversal5", "pullback2_v1", "breakout20_v1"]);
    assert.throws(() => settings.save({ maxRiskPct: 999 }));
    assert.throws(() => settings.save({ perTradeMinPct: 50, perTradeMaxPct: 10 }), /מקסימלי/);
    const saved = settings.save({ totalExposurePct: 70 });
    assert.equal(saved.totalExposurePct, 70);
    assert.equal(settings.read().totalExposurePct, 70, "persists across read()");
  } finally {
    cleanup();
  }
});

test("risk: day base is fixed once, loss is measured against it, and the breach latches", async () => {
  const { risk, broker, cleanup } = setup();
  try {
    let equity = 10000;
    broker.getAccount = async () => ({ equity });
    const base = await risk.ensureDayBase(1000);
    assert.equal(base.baseEquity, 10000);

    equity = 9700; // -3%, below a 7% cap
    let day = await risk.evaluateDay(2000, 7);
    assert.equal(day.breached, false);
    assert.equal(day.loss, 300);

    equity = 9000; // -10%, past a 7% cap
    day = await risk.evaluateDay(3000, 7);
    assert.equal(day.breached, true);

    equity = 9999; // recovers, but the breach must latch
    day = await risk.evaluateDay(4000, 7);
    assert.equal(day.breached, true);

    // Restarting the same NY day must not reset the base.
    const again = await risk.ensureDayBase(5000);
    assert.equal(again.baseEquity, 10000);
  } finally {
    cleanup();
  }
});

test("risk: validateSignal blocks on a breached day", async () => {
  const { risk, broker, cleanup } = setup();
  try {
    broker.getAccount = async () => ({ equity: 5000 });
    await risk.ensureDayBase(1000);
    broker.getAccount = async () => ({ equity: 100 }); // -98%, breaches any reasonable cap
    await assert.rejects(
      risk.validateSignal({ symbol: "AAPL", equity: 100, now: 2000, profile: { dailyLossPct: 7 } }),
      /הפסד יומי/,
    );
  } finally {
    cleanup();
  }
});

test("risk: validateSignal blocks a symbol that already has a position or a pending order", async () => {
  const { risk, broker, cleanup } = setup();
  try {
    broker.getAccount = async () => ({ equity: 10000 });
    await risk.ensureDayBase(1000);
    broker.getPositions = async () => [{ symbol: "MSFT" }];
    broker.getOrders = async () => [];
    await assert.rejects(risk.validateSignal({ symbol: "MSFT", equity: 10000, now: 2000, profile: { dailyLossPct: 7 } }), /פוזיציה או הזמנה פתוחה/);
    await assert.doesNotReject(risk.validateSignal({ symbol: "GOOGL", equity: 10000, now: 2000, profile: { dailyLossPct: 7 } }));
  } finally {
    cleanup();
  }
});

test("entry: a box scores, sizes and enters once, then locks the symbol for the day", async () => {
  const { entry, cleanup } = setup();
  try {
    const profile = { windowMin: 5, minScore: 45, immediateScore: 80, familyPoints: [40, 65, 80, 90], qualityMax: 10, catalystMax: 8, perTradeMinPct: 30, perTradeMaxPct: 50, totalExposurePct: 60, maxRiskPct: 4, minShares: 1 };
    const now = Date.parse("2026-11-03T15:00:00Z");
    const signal = {
      id: "AAPL:orb15:bar1", ticker: "AAPL", strategy: "orb15", entry: 200, stop: 198,
      daily: { atr14: 2, avgDollarVolume20d: 80_000_000 }, rvol: 3,
      expiresAt: new Date(now + 600000).toISOString(),
    };
    entry.observe({ signal, now });
    let placed = null;
    const results = await entry.flush({
      profile, equity: 10000, exposure: 0, enabled: true, now: now + 6 * 60000,
      place: async (symbol, shares) => { placed = { symbol, shares }; return { orderId: "o1" }; },
    });
    assert.equal(results[0].outcome, "entered");
    assert.ok(placed && placed.symbol === "AAPL" && placed.shares > 0);

    // A second signal the same day for the same symbol must not re-enter.
    entry.observe({ signal: { ...signal, id: "AAPL:orb15:bar2" }, now: now + 7 * 60000 });
    const again = await entry.flush({ profile, equity: 10000, exposure: 0, enabled: true, now: now + 13 * 60000, place: async () => { throw new Error("must not be called"); } });
    assert.equal(again.length, 0, "the box is already closed as entered, nothing new to decide");
  } finally {
    cleanup();
  }
});

test("exit: closes a position that crossed its stop, and leaves others alone", async () => {
  const { exitManager, broker, cleanup } = setup();
  try {
    exitManager.recordPlan("AAPL", { stop: 198, target: 210 });
    exitManager.recordPlan("MSFT", { stop: 300, target: 320 });
    const closed = [];
    broker.getPositions = async () => [
      { symbol: "AAPL", qty: "10", current_price: "197.5" },
      { symbol: "MSFT", qty: "5", current_price: "305" },
    ];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const results = await exitManager.manage({ dailyBreached: false, now: Date.parse("2026-11-03T15:00:00Z") });
    assert.deepEqual(closed, ["AAPL"]);
    assert.equal(results[0].reason, "stop");
  } finally {
    cleanup();
  }
});

test("universe: the memory guard stops the build early instead of ballooning (the 2026-11-03 OOM bug)", async () => {
  process.env.ALPACA_TRADER_MEMORY_GUARD_MB = "1"; // process RSS always exceeds 1MB: guard fires on batch 1
  const { universe, alpacaService, cleanup } = setup();
  try {
    assert.equal(universe.overMemoryGuard(), true);
    let barsCalls = 0;
    alpacaService.getActiveAssets = async () => [
      { symbol: "AAAA", name: "A Corp common stock" },
      { symbol: "BBBB", name: "B Corp common stock" },
    ];
    alpacaService.getBarsDetailed = async () => { barsCalls += 1; return { bars: new Map() }; };
    const rows = await universe.build(Date.now(), { minPrice: 3, minAdv20: 3_000_000 });
    assert.deepEqual(rows, []);
    assert.equal(barsCalls, 0, "stops before the first batch fetch, not after ballooning");
    assert.equal(universe.status().diagnostics.memoryGuardStopped, true);
  } finally {
    cleanup();
  }
});

test("scan: intraday bars are requested for today's session only, never the 26-day default (the OOM root cause)", async () => {
  const { universe, cleanup } = setup();
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/scan")];
    delete require.cache[require.resolve("../src/autopilot/history")];
    const history = require("../src/autopilot/history");
    const scan = require("../src/alpaca-trader/scan");
    const now = Date.parse("2026-11-03T15:00:00Z"); // Tuesday 10:00 New York, inside the session
    universe.getRows = () => [{ symbol: "AAAA" }, { symbol: "BBBB" }];
    history.ensureDailyFeatures = async () => ({ features: new Map(), complete: true });
    const calls = [];
    history.ensureIntradayBars = async (symbols, options) => { calls.push({ symbols, options }); return { bars: new Map(), errors: [] }; };
    const diagnostics = await scan.run({ strategies: [], minPrice: 3, minAdv20: 3e6 }, now);
    assert.equal(diagnostics.marketOpen, true);
    assert.equal(calls.length, 1);
    const { open } = scan.sessionBounds(now);
    assert.equal(calls[0].options.start, new Date(open).toISOString(), "start is today's session open, not 26 days back");
    assert.ok(Date.parse(calls[0].options.start) > now - 24 * 3600 * 1000, "within the last day");
  } finally {
    cleanup();
  }
});

test("exit: end of day closes positions at 15:55 New York and not before (was dead code: NaN from Date.parse(number))", async () => {
  const { exitManager, broker, cleanup } = setup();
  try {
    assert.equal(exitManager.isPastClose(Date.parse("2026-11-03T20:50:00Z")), false); // 15:50 NY
    assert.equal(exitManager.isPastClose(Date.parse("2026-11-03T20:56:00Z")), true); // 15:56 NY
    const closed = [];
    broker.getPositions = async () => [{ symbol: "AAPL", qty: "10", current_price: "200" }];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const results = await exitManager.manage({ dailyBreached: false, now: Date.parse("2026-11-03T20:56:00Z") });
    assert.deepEqual(closed, ["AAPL"]);
    assert.equal(results[0].reason, "end_of_day");
  } finally {
    cleanup();
  }
});

test("exit: a daily-loss breach closes every position regardless of price", async () => {
  const { exitManager, broker, cleanup } = setup();
  try {
    const closed = [];
    broker.getPositions = async () => [{ symbol: "AAPL", qty: "10", current_price: "500" }];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const results = await exitManager.manage({ dailyBreached: true, now: Date.parse("2026-11-03T15:00:00Z") });
    assert.deepEqual(closed, ["AAPL"]);
    assert.equal(results[0].reason, "daily_loss_breached");
  } finally {
    cleanup();
  }
});

test("universe: keeps the most volatile names inside the liquidity band, not the biggest mega-caps", async () => {
  const { universe, settings, alpacaService, cleanup } = setup();
  try {
    assert.equal(settings.read().maxAdv20, 150_000_000, "default upper liquidity bound");
    const now = Date.parse("2026-11-05T15:00:00Z");
    // 25 daily bars before today: close 10, daily range as given, volume chosen for the dollar volume.
    const barsFor = (rangePct, dollarVolume, close = 10) =>
      Array.from({ length: 25 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, "0")}T04:00:00Z`, c: close, h: close * (1 + rangePct / 2), l: close * (1 - rangePct / 2), v: dollarVolume / close }));
    const data = {
      MEGA: barsFor(0.01, 5_000_000_000, 200), // huge liquidity, calm: above the upper bound
      CALM: barsFor(0.01, 10_000_000),
      WILD: barsFor(0.12, 20_000_000),
      MID: barsFor(0.05, 40_000_000),
      PENNY: barsFor(0.2, 50_000_000, 1), // below the price floor
      THIN: barsFor(0.3, 500_000), // below the liquidity floor
    };
    alpacaService.getActiveAssets = async () => Object.keys(data).map((symbol) => ({ symbol, name: `${symbol} Corp common stock` }));
    alpacaService.getBarsDetailed = async ({ symbols }) => ({ bars: new Map(symbols.map((s) => [s, data[s]])) });
    const rows = await universe.build(now, settings.read());
    assert.deepEqual(rows.map((r) => r.symbol), ["WILD", "MID", "CALM"], "most volatile first; mega-cap, penny and thin names excluded");
    const { diagnostics } = universe.status(now);
    assert.equal(diagnostics.aboveLiquidity, 1);
    assert.equal(diagnostics.belowPrice, 1);
    assert.equal(diagnostics.belowLiquidity, 1);
    assert.deepEqual(universe.getRows(now).map((r) => r.symbol), ["WILD", "MID", "CALM"]);
  } finally {
    cleanup();
  }
});

test("universe + scan: relative volume compares today's IEX volume with the stock's own IEX average (SIP-vs-IEX mix-up gave rvol~0.03 and 0 matches)", async () => {
  const { universe, settings, alpacaService, cleanup } = setup();
  try {
    const now = Date.parse("2026-11-05T15:00:00Z"); // 10:00 New York
    const dailyBars = (v) => Array.from({ length: 25 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, "0")}T04:00:00Z`, c: 10, h: 10.5, l: 9.5, v }));
    alpacaService.getActiveAssets = async () => [{ symbol: "AAAA", name: "A Corp common stock" }];
    alpacaService.getBarsDetailed = async ({ symbols, feed }) => ({ bars: new Map(symbols.map((s) => [s, dailyBars(feed === "iex" ? 1000 : 5_000_000)])) });
    const rows = await universe.build(now, settings.read());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].avgIexVolume20d, 1000, "IEX average, not the SIP one");

    delete require.cache[require.resolve("../src/alpaca-trader/scan")];
    delete require.cache[require.resolve("../src/autopilot/history")];
    const history = require("../src/autopilot/history");
    const scan = require("../src/alpaca-trader/scan");
    history.ensureDailyFeatures = async () => ({ features: new Map([["AAAA", { features: { avgVolume20d: 5_000_000 } }]]), complete: true });
    const intraday = Array.from({ length: 6 }, (_, i) => ({ t: new Date(Date.parse("2026-11-05T14:30:00Z") + i * 300000).toISOString(), o: 10, h: 10.1, l: 9.9, c: 10, v: 100 }));
    history.ensureIntradayBars = async () => ({ bars: new Map([["AAAA", intraday]]), errors: [] });
    const diagnostics = await scan.run({ strategies: [], minPrice: 3, minAdv20: 3e6, maxAdv20: 150e6 }, now);
    // 600 shares so far vs 1000 * (30 min / 390 min) expected = ~7.8x; against the SIP average it would be ~0.0016x.
    assert.ok(diagnostics.rvolMax > 7 && diagnostics.rvolMax < 8.5, `rvolMax ${diagnostics.rvolMax}`);
    assert.equal(diagnostics.rvolOver1_2, 1);
    assert.deepEqual(Object.keys(diagnostics.reasons), [], "no enabled strategies in this profile, so nothing to summarise");
    const withStrategy = await scan.run({ strategies: ["orb15"], minPrice: 3, minAdv20: 3e6, maxAdv20: 150e6 }, now);
    assert.deepEqual(withStrategy.reasons, { orb15: { daily_missing: 1 } }, "reason counts per enabled strategy");
  } finally {
    cleanup();
  }
});

test("engine: scans are aligned to just after each 5-minute boundary (a late phase made every stock intraday_missing)", () => {
  const { cleanup } = setup();
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/engine")];
    const { msUntilNextBar } = require("../src/alpaca-trader/engine");
    const at = (hhmmss) => Date.parse(`2026-11-06T${hhmmss}Z`);
    assert.equal(msUntilNextBar(at("15:04:34"), 20000), 46000, "26s to the boundary, then 20s");
    assert.equal(msUntilNextBar(at("15:05:05"), 20000), 15000, "already past the boundary but still before its 20s delay");
    assert.equal(msUntilNextBar(at("15:05:30"), 20000), 290000, "just missed this one: wait for the next boundary");
    for (const second of [0, 59, 120, 241, 299]) {
      const now = at("15:00:00") + second * 1000;
      const fire = new Date(now + msUntilNextBar(now, 20000));
      assert.equal(fire.getUTCSeconds(), 20);
      assert.equal(fire.getUTCMinutes() % 5, 0);
    }
  } finally {
    cleanup();
  }
});

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
  for (const file of ["../src/alpaca-trader/notify", "../src/autopilot/notifications", "../src/autopilot/settings"]) delete require.cache[require.resolve(file)];
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
    const meta = entry.tradeMeta();
    assert.equal(meta.length, 1, "a durable entry record is kept for the trade report");
    assert.deepEqual([meta[0].orderId, meta[0].symbol, meta[0].lead, meta[0].plannedPrice], ["o1", "AAPL", "orb15", 200]);

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

test("trades: pairs Alpaca fills FIFO into realized trades, joins strategy/slippage/exit reason, and summarizes per strategy", () => {
  const { cleanup } = setup();
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/trades")];
    const trades = require("../src/alpaca-trader/trades");
    const fill = (id, symbol, side, qty, price, at) => ({ id, symbol, side, filled_qty: String(qty), filled_avg_price: String(price), filled_at: at });
    const orders = [
      fill("b1", "AAA", "buy", 100, 10.1, "2026-11-06T15:30:05Z"),
      fill("s1", "AAA", "sell", 100, 11, "2026-11-06T16:30:10Z"), // +90
      fill("b2", "BBB", "buy", 200, 5, "2026-11-06T17:00:03Z"),
      fill("s2", "BBB", "sell", 80, 4.9, "2026-11-06T17:05:02Z"), // partial exit: -8
      fill("s3", "BBB", "sell", 120, 4.8, "2026-11-06T17:06:02Z"), // rest: -24
      { id: "x", symbol: "CCC", side: "buy", filled_qty: "0", filled_avg_price: null, filled_at: null }, // never filled: ignored
    ];
    const paired = trades.pairTrades(orders);
    assert.equal(paired.length, 3);
    assert.equal(paired[0].pnl.toFixed(2), "90.00");
    assert.equal(paired[1].qty, 80);
    assert.equal(paired[2].pnl.toFixed(2), "-24.00");

    const enriched = trades.enrich(paired, {
      meta: [{ orderId: "b1", symbol: "AAA", strategies: ["orb15", "vwap_reclaim"], lead: "orb15", score: 70, plannedPrice: 10 }],
      entered: [{ symbol: "BBB", at: "2026-11-06T17:00:00Z", strategies: ["vwap_pullback"], score: 50, price: 5 }],
      exits: [{ symbol: "AAA", at: "2026-11-06T16:30:00Z", reason: "target" }, { symbol: "BBB", at: "2026-11-06T17:05:00Z", reason: "stop" }],
    });
    assert.equal(enriched[0].strategy, "orb15");
    assert.equal(enriched[0].slippagePct.toFixed(1), "1.0", "filled 10.10 against a planned 10.00");
    assert.equal(enriched[0].exitReason, "target");
    assert.equal(enriched[1].strategy, "vwap_pullback", "matched by symbol and time when there is no order-id metadata");
    assert.equal(enriched[1].exitReason, "stop");

    const stats = trades.buildStats(enriched);
    assert.equal(stats.overall.trades, 3);
    assert.equal(stats.overall.wins, 1);
    assert.equal(stats.overall.totalPnl.toFixed(2), "58.00");
    assert.deepEqual(stats.byStrategy.map((s) => [s.strategy, Math.round(s.totalPnl)]), [["orb15", 90], ["vwap_pullback", -32]]);
  } finally {
    cleanup();
  }
});

test("exit: break-even trailing stop moves the stop to the entry at 1R, never lowers it, and closes a trade that falls back", async () => {
  const { exitManager, broker, settings, cleanup } = setup();
  try {
    assert.equal(settings.read().trailingStopEnabled, true);
    assert.equal(settings.read().breakEvenAtR, 1);
    exitManager.recordPlan("TRAIL", { stop: 98, target: 104 }); // entry 100 -> risk 2 -> break-even trigger at 102
    const closed = [];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const position = (price) => [{ symbol: "TRAIL", qty: "10", avg_entry_price: "100", current_price: String(price) }];
    const now = Date.parse("2026-11-09T15:00:00Z");

    broker.getPositions = async () => position(101.5); // up 0.75R: nothing yet
    assert.deepEqual(await exitManager.manage({ dailyBreached: false, now }), []);
    assert.equal(exitManager.plans()[0].stop, 98);

    broker.getPositions = async () => position(102.2); // up 1.1R: stop moves to the entry, no exit
    assert.deepEqual(await exitManager.manage({ dailyBreached: false, now }), []);
    const armed = exitManager.plans()[0];
    assert.equal(armed.stop, 100);
    assert.equal(armed.initialStop, 98, "the original risk is remembered");
    assert.ok(armed.breakEvenAt);

    broker.getPositions = async () => position(101); // pulled back but still above the entry: stays open
    assert.deepEqual(await exitManager.manage({ dailyBreached: false, now }), []);
    assert.deepEqual(closed, []);

    broker.getPositions = async () => position(99.9); // back through the entry: closed at break-even, not at the old -2 stop
    const results = await exitManager.manage({ dailyBreached: false, now });
    assert.deepEqual(closed, ["TRAIL"]);
    assert.equal(results[0].reason, "breakeven_stop");
  } finally {
    cleanup();
  }
});

test("exit: the trailing stop does nothing when switched off, and never moves a stop that is already above the entry", async () => {
  const { exitManager, settings, cleanup } = setup();
  try {
    const now = Date.parse("2026-11-09T15:00:00Z");
    const plan = { symbol: "X", stop: 98, initialStop: 98, target: 104 };
    const base = { entryPrice: 100, price: 103, now };
    assert.equal(exitManager.armBreakEven(plan, { ...base, profile: { trailingStopEnabled: false, breakEvenAtR: 1 } }), plan, "disabled: unchanged");
    assert.equal(exitManager.armBreakEven(plan, { ...base, profile: { trailingStopEnabled: true, breakEvenAtR: 2 } }), plan, "needs 2R: 103 is only 1.5R");
    assert.equal(exitManager.armBreakEven({ ...plan, stop: 101 }, { ...base, profile: { trailingStopEnabled: true, breakEvenAtR: 1 } }).stop, 101, "an already higher stop is kept");
    assert.equal(exitManager.armBreakEven(plan, { entryPrice: NaN, price: 103, now, profile: { trailingStopEnabled: true, breakEvenAtR: 1 } }), plan, "missing entry price: unchanged");
    assert.throws(() => settings.save({ breakEvenAtR: 0 }));
    assert.equal(settings.save({ trailingStopEnabled: false }).trailingStopEnabled, false);
  } finally {
    cleanup();
  }
});

test("entry: several boxes decided in the same pass share the exposure limit instead of each using all of it (the 2026-11-10 over-allocation)", async () => {
  const { entry, cleanup } = setup();
  try {
    const profile = { windowMin: 5, minScore: 45, immediateScore: 80, familyPoints: [40, 65, 80, 90], qualityMax: 10, catalystMax: 8, perTradeMinPct: 30, perTradeMaxPct: 50, totalExposurePct: 60, maxRiskPct: 4, minShares: 1 };
    const now = Date.parse("2026-11-10T15:00:00Z");
    for (const ticker of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]) {
      entry.observe({
        signal: { id: `${ticker}:orb15:bar1`, ticker, strategy: "orb15", entry: 10, stop: 9.5, daily: { atr14: 1, avgDollarVolume20d: 80_000_000 }, rvol: 3, expiresAt: new Date(now + 600000).toISOString() },
        now,
      });
    }
    const placed = [];
    const results = await entry.flush({
      profile, equity: 100_000, exposure: 0, enabled: true, now: now + 6 * 60000,
      place: async (symbol, shares) => { placed.push({ symbol, shares, notional: shares * 10 }); return { orderId: `o-${symbol}` }; },
    });
    const total = placed.reduce((sum, p) => sum + p.notional, 0);
    assert.ok(placed.length >= 1, "something is still bought");
    assert.ok(total <= 60_000 + 1, `six boxes together stay inside 60% of the account, got ${total}`);
    assert.ok(results.filter((r) => r.outcome === "skipped").length >= 1, "boxes that no longer fit are skipped, not oversized");
  } finally {
    cleanup();
  }
});

test("engine status writes survive a locked database instead of crashing the process (the 2026-11-09 exit 1 during a rolling deploy)", () => {
  const { store, cleanup } = setup();
  const realPut = store.put;
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(String(line));
  try {
    for (const modulePath of ["../src/alpaca-trader/engine", "../src/autopilot/engine"]) delete require.cache[require.resolve(modulePath)];
    const alpacaEngine = require("../src/alpaca-trader/engine");
    store.put = () => { throw new Error("database is locked"); };
    // The alpaca engine's status write happens inside tick(); the autopilot one is exported directly.
    const autopilotEngine = require("../src/autopilot/engine");
    assert.equal(autopilotEngine.state({ error: "x" }), null, "no throw, returns null");
    assert.ok(warnings.some((w) => /state update skipped: database is locked/.test(w)));
    assert.equal(typeof alpacaEngine.tick, "function");
  } finally {
    store.put = realPut;
    console.warn = warn;
    cleanup();
  }
});

test("exit: nothing is submitted after the regular session (it would only queue for the next open), and a position carried over from an earlier day is closed at the first chance", async () => {
  const { exitManager, broker, cleanup } = setup();
  try {
    exitManager.recordPlan("LATE", { stop: 3, target: 4 }, Date.parse("2026-11-09T15:00:00Z"));
    const closed = [];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    broker.getPositions = async () => [{ symbol: "LATE", qty: "100", avg_entry_price: "3.5", current_price: "3.4" }];

    // 16:20 New York on 2026-11-09: the real incident. Past 15:55, but the market is closed: no order.
    assert.deepEqual(await exitManager.manage({ dailyBreached: false, now: Date.parse("2026-11-09T21:20:00Z") }), []);
    assert.deepEqual(closed, []);
    assert.equal(exitManager.inSession(Date.parse("2026-11-09T20:59:00Z")), true, "15:59 New York is still the session");
    assert.equal(exitManager.inSession(Date.parse("2026-11-09T21:00:00Z")), false);
    assert.equal(exitManager.inSession(Date.parse("2026-11-07T16:00:00Z")), false, "Saturday");

    // Next morning, 09:35 New York: entered yesterday, so it is closed immediately even though stop/target are not hit.
    const results = await exitManager.manage({ dailyBreached: false, now: Date.parse("2026-11-10T14:35:00Z") });
    assert.deepEqual(closed, ["LATE"]);
    assert.equal(results[0].reason, "carried_over");
  } finally {
    cleanup();
  }
});

test("engine: the exit loop closes a stopped-out position by itself during the session, and stays idle outside it", async () => {
  const { exitManager, broker, cleanup } = setup();
  process.env.ALPACA_TRADER_API_KEY_ID = "test";
  process.env.ALPACA_TRADER_API_SECRET_KEY = "test";
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/engine")];
    const engine = require("../src/alpaca-trader/engine");
    exitManager.recordPlan("STOPME", { stop: 9, target: 12 }, Date.parse("2026-11-10T14:40:00Z"));
    const closed = [];
    broker.getAccount = async () => ({ equity: "100000" });
    broker.getPositions = async () => [{ symbol: "STOPME", qty: "50", avg_entry_price: "10", current_price: "8.9" }];
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };

    assert.deepEqual(await engine.exitTick(Date.parse("2026-11-10T22:00:00Z")), [], "after the close: idle");
    assert.deepEqual(closed, []);
    const results = await engine.exitTick(Date.parse("2026-11-10T15:00:00Z"));
    assert.deepEqual(closed, ["STOPME"]);
    assert.equal(results[0].reason, "stop");
  } finally {
    delete process.env.ALPACA_TRADER_API_KEY_ID;
    delete process.env.ALPACA_TRADER_API_SECRET_KEY;
    cleanup();
  }
});

test("notify: opted-in profiles get a push event for every buy and every exit; others get nothing", async () => {
  const { store, entry, exitManager, broker, cleanup } = setup();
  try {
    const notify = require("../src/alpaca-trader/notify");
    const settingsOfUsers = require("../src/autopilot/settings");
    assert.equal(notify.isEnabled("user-a"), false);
    notify.setEnabled("user-a", true);
    assert.equal(notify.isEnabled("user-a"), true);
    // A profile that only wants Colmex purchases pushed (pushOnlyBought) must still get these.
    settingsOfUsers.save({ pushOnlyBought: true }, "user-a");
    assert.equal(settingsOfUsers.read("user-a").pushOnlyBought, true, "the filter really is on for this profile");

    // Buy
    const profile = { windowMin: 5, minScore: 45, immediateScore: 80, familyPoints: [40, 65, 80, 90], qualityMax: 10, catalystMax: 8, perTradeMinPct: 30, perTradeMaxPct: 50, totalExposurePct: 60, maxRiskPct: 4, minShares: 1 };
    const now = Date.parse("2026-11-11T15:00:00Z");
    entry.observe({ signal: { id: "NTFY:orb15:bar1", ticker: "NTFY", strategy: "orb15", entry: 20, stop: 19, target: 22, daily: { atr14: 2, avgDollarVolume20d: 80_000_000 }, rvol: 3, expiresAt: new Date(now + 600000).toISOString() }, now });
    await entry.flush({ profile, equity: 100000, exposure: 0, enabled: true, now: now + 6 * 60000, place: async () => ({ orderId: "ord-1" }) });
    const buy = store.getUser("user-a", "event", "alpaca:entry:ord-1");
    assert.ok(buy, "buy event stored");
    assert.match(buy.title, /נקנתה NTFY/);
    assert.match(buy.body, /סטופ \$19\.00 · יעד \$22\.00/);
    assert.ok(store.getUser("user-a", "outbox", "alpaca:entry:ord-1"), "queued for push even with pushOnlyBought");

    // Exit
    exitManager.recordPlan("NTFY", { stop: 19, target: 22 }, now);
    broker.getPositions = async () => [{ symbol: "NTFY", qty: "100", avg_entry_price: "20", current_price: "18.5", unrealized_pl: "-150" }];
    broker.closePosition = async () => ({});
    await exitManager.manage({ dailyBreached: false, now: now + 3600000 });
    const exitEvents = store.listUser("user-a", "event").filter((e) => e.id.startsWith("alpaca:exit:NTFY"));
    assert.equal(exitEvents.length, 1);
    assert.match(exitEvents[0].title, /יציאה מ-NTFY \(סטופ\)/);
    assert.match(exitEvents[0].body, /-\$150/);

    // A profile that never opted in gets nothing
    assert.equal(store.listUser("user-b", "event").length, 0);
    // Opt-out stops further notices
    notify.setEnabled("user-a", false);
    assert.equal(notify.entered({ symbol: "ZZZ", shares: 1, price: 1, equity: 1000, stop: 0.9, target: 1.2, score: 50, now }), 0);
  } finally {
    cleanup();
  }
});

test("engine: each in-session scan is kept in a short history with summed reason codes (to answer 'why was nothing bought')", () => {
  const { cleanup } = setup();
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/engine")];
    const engine = require("../src/alpaca-trader/engine");
    const at = (hhmm) => Date.parse(`2026-11-11T${hhmm}:20Z`);
    engine.recordScan(at("15:05"), { marketOpen: false }, []); // outside the session: not recorded
    engine.recordScan(at("15:10"), { marketOpen: true, universeSize: 150, evaluated: 140, matched: 0, rvolOver1_2: 30, rvolMax: 3.2, errors: [], reasons: { orb15: { trigger_not_met: 100, intraday_missing: 40 }, vwap_reclaim: { trigger_not_met: 90, intraday_missing: 40, matched: 1 } } }, []);
    engine.recordScan(at("15:15"), { marketOpen: true, universeSize: 150, evaluated: 141, matched: 2, rvolOver1_2: 31, rvolMax: 3.4, errors: [], reasons: {} }, [{ outcome: "entered" }, { outcome: "skipped" }]);
    const scans = engine.recentScans(10);
    assert.equal(scans.length, 2);
    assert.equal(scans[0].at, "2026-11-11T15:15:20.000Z", "newest first");
    assert.equal(scans[0].entered, 1);
    assert.deepEqual(scans[1].reasons, { trigger_not_met: 190, intraday_missing: 80, matched: 1 }, "summed over strategies");
  } finally {
    cleanup();
  }
});

test("scan: a scan that starts a few minutes into a 5-minute window still sees the latest closed candle as fresh (all stocks were intraday_missing)", async () => {
  const { universe, cleanup } = setup();
  try {
    delete require.cache[require.resolve("../src/alpaca-trader/scan")];
    delete require.cache[require.resolve("../src/autopilot/history")];
    const history = require("../src/autopilot/history");
    const scan = require("../src/alpaca-trader/scan");
    const now = Date.parse("2026-11-12T15:02:52Z"); // 10:02:52 New York: 2:52 after the 15:00 boundary
    universe.getRows = () => [{ symbol: "LATE", avgIexVolume20d: 1000 }];
    history.ensureDailyFeatures = async () => ({ features: new Map([["LATE", { features: { atr14: 1, avgVolume20d: 5_000_000, price: 10 } }]]), complete: true });
    // Candles 14:30 .. 14:55: the 14:55 one closed at 15:00, the 15:00 one is still forming at 15:02:52.
    const bars = Array.from({ length: 6 }, (_, i) => ({ t: new Date(Date.parse("2026-11-12T14:30:00Z") + i * 300000).toISOString(), o: 10, h: 10.1, l: 9.9, c: 10, v: 100 }));
    history.ensureIntradayBars = async () => ({ bars: new Map([["LATE", bars]]), errors: [] });
    const diagnostics = await scan.run({ strategies: ["orb15"], minPrice: 3, minAdv20: 3e6, maxAdv20: 150e6 }, now);
    assert.ok(!diagnostics.reasons.orb15?.intraday_missing, JSON.stringify(diagnostics.reasons));
    assert.equal(Object.values(diagnostics.reasons.orb15 || {}).reduce((a, b) => a + b, 0), 1, "the stock was evaluated by the strategy");
  } finally {
    cleanup();
  }
});

test("exit: at the target half is sold, the rest loses its fixed target, locks profit and trails the highest price", async () => {
  const { exitManager, broker, settings, cleanup } = setup();
  try {
    assert.deepEqual([settings.read().partialEnabled, settings.read().partialPct, settings.read().partialLockR, settings.read().partialTrailR], [true, 50, 1, 1]);
    exitManager.recordPlan("RUN", { stop: 98, target: 104 }); // entry 100: risk 2, target 2R
    const sold = [];
    const closed = [];
    broker.placeMarketOrder = async (order) => { sold.push(order); return { id: "s1" }; };
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const position = (qty, price) => [{ symbol: "RUN", qty: String(qty), avg_entry_price: "100", current_price: String(price), unrealized_pl: String((price - 100) * qty) }];
    const now = Date.parse("2026-11-12T16:00:00Z");

    broker.getPositions = async () => position(100, 104.2); // reaches the target
    let results = await exitManager.manage({ dailyBreached: false, now });
    assert.deepEqual(sold, [{ symbol: "RUN", qty: 50, side: "sell" }]);
    assert.deepEqual(closed, [], "the position is not closed");
    assert.equal(results[0].outcome, "partial");
    let plan = exitManager.plans()[0];
    assert.equal(plan.target, null, "no fixed target for the rest");
    assert.equal(plan.stop, 102.2, "at least entry + 1R (102), and 2 below the high of 104.2");
    assert.equal(plan.partialQty, 50);

    broker.getPositions = async () => position(50, 104.2); // still at the target: no second partial
    assert.deepEqual(await exitManager.manage({ dailyBreached: false, now: now + 30000 }), []);
    assert.equal(sold.length, 1);

    broker.getPositions = async () => position(50, 108); // new high: the stop follows, never down
    await exitManager.manage({ dailyBreached: false, now: now + 60000 });
    assert.equal(exitManager.plans()[0].stop, 106);
    broker.getPositions = async () => position(50, 106.5);
    await exitManager.manage({ dailyBreached: false, now: now + 90000 });
    assert.equal(exitManager.plans()[0].stop, 106, "a pullback does not lower the stop");

    broker.getPositions = async () => position(50, 105.9); // falls through the trailing stop
    results = await exitManager.manage({ dailyBreached: false, now: now + 120000 });
    assert.deepEqual(closed, ["RUN"]);
    assert.equal(results[0].reason, "trailing_stop");
  } finally {
    cleanup();
  }
});

test("exit: with partial profit-taking off, or a position too small to split, the target still closes everything", async () => {
  const { exitManager, broker, settings, cleanup } = setup();
  try {
    const sold = [];
    const closed = [];
    broker.placeMarketOrder = async (order) => { sold.push(order); return {}; };
    broker.closePosition = async (symbol) => { closed.push(symbol); return {}; };
    const now = Date.parse("2026-11-12T16:00:00Z");
    const hit = (symbol, qty) => [{ symbol, qty: String(qty), avg_entry_price: "100", current_price: "104.5", unrealized_pl: String(4.5 * qty) }];

    exitManager.recordPlan("ONE", { stop: 98, target: 104 });
    broker.getPositions = async () => hit("ONE", 1); // one share cannot be split
    assert.equal((await exitManager.manage({ dailyBreached: false, now }))[0].reason, "target");
    assert.deepEqual([sold.length, closed], [0, ["ONE"]]);

    settings.save({ partialEnabled: false });
    exitManager.recordPlan("OFF", { stop: 98, target: 104 });
    broker.getPositions = async () => hit("OFF", 100);
    assert.equal((await exitManager.manage({ dailyBreached: false, now }))[0].reason, "target");
    assert.deepEqual([sold.length, closed], [0, ["ONE", "OFF"]]);
    assert.throws(() => settings.save({ partialPct: 5 }));
    assert.throws(() => settings.save({ partialLockR: 3 }));
  } finally {
    cleanup();
  }
});

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

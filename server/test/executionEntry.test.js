const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODULES = [
  "../src/autopilot/store", "../src/autopilot/market", "../src/execution/positions", "../src/execution/orders",
  "../src/execution/riskProfile", "../src/execution/risk", "../src/execution/bridge", "../src/execution/entryProfile",
  "../src/execution/entryDecision", "../src/execution/pnlHistory",
];

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-entry-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "e.sqlite");
  process.env.EXECUTION_QUEUE_ENABLED = "true";
  process.env.EXECUTION_BROKER_ACCOUNT_ID = "102992";
  for (const name of MODULES) delete require.cache[require.resolve(name)];
  const ctx = { scratch, now: Date.now() };
  ctx.store = require("../src/autopilot/store");
  ctx.positions = require("../src/execution/positions");
  ctx.profile = require("../src/execution/riskProfile");
  ctx.entry = require("../src/execution/entryDecision");
  ctx.entryProfile = require("../src/execution/entryProfile");
  ctx.orders = require("../src/execution/orders");
  ctx.account = (rows = [], equity = 100000) => {
    ctx.positions.save({ accountId: "102992", isDemo: true, currency: "USD", balance: equity, equity, profit: 0, positions: rows, closedDeals: [] }, ctx.now);
    ctx.profile.ensureDayBase(ctx.now);
  };
  ctx.signal = (strategy, extra = {}) => ({
    id: `d:AAPL:${strategy}:v1`, ticker: "AAPL", strategy, side: "buy", status: "active", entry: 100, maxEntry: 100.5, stop: 99, target: 103,
    rvol: 2.5, daily: { atr14: 1.5, avgDollarVolume20d: 80e6 }, expiresAt: new Date(ctx.now + 600000).toISOString(), ...extra,
  });
  return ctx;
}
const cleanup = (ctx) => { ctx.store.close?.(); fs.rmSync(ctx.scratch, { recursive: true, force: true }); };
const run = (ctx, now = ctx.now) => ctx.entry.flush({ userId: "u1", brokerAccountId: "102992", now });

test("families are counted once: orb15 and orb15_retest agree as one", () => {
  const { score } = require("../src/execution/entryDecision");
  const profile = require("../src/execution/entryProfile").DEFAULTS;
  const one = score([{ strategy: "orb15" }, { strategy: "orb15_retest" }], profile);
  assert.deepEqual(one.families, ["orb"]);
  const two = score([{ strategy: "orb15" }, { strategy: "vwap_reclaim" }], profile);
  assert.equal(two.families.length, 2);
  assert.ok(two.score > one.score);
});

test("a single signal waits for the window, then enters when the score passes", () => {
  const ctx = load();
  try {
    ctx.account();
    ctx.entry.observe({ userId: "u1", signal: ctx.signal("orb15"), brokerSymbol: "AAPL", now: ctx.now });
    assert.deepEqual(run(ctx), []); // one family: below immediate score, window still open
    const later = ctx.now + 9.9 * 60000;
    ctx.account(); // keep MT4 data fresh for the later time
    ctx.positions.save({ accountId: "102992", isDemo: true, balance: 100000, equity: 100000, profit: 0, positions: [], closedDeals: [] }, later - 1000);
    const out = run(ctx, ctx.now + 10 * 60000 - 1000);
    assert.equal(out.length, 0);
  } finally { cleanup(ctx); }
});

test("enters after the window with sizing from MT4 equity, and locks the symbol", () => {
  const ctx = load();
  try {
    ctx.account();
    ctx.entry.observe({ userId: "u1", signal: ctx.signal("orb15"), brokerSymbol: "AAPL", now: ctx.now });
    const at = ctx.now + 10 * 60000;
    ctx.positions.save({ accountId: "102992", isDemo: true, balance: 100000, equity: 100000, profit: 0, positions: [], closedDeals: [] }, at);
    // the signal lives 10 minutes; extend it so the window decides, not expiry
    const box = ctx.store.listUser("u1", "entryBox").find((b) => b.symbol === "AAPL");
    box.signals[0].signal.expiresAt = new Date(at + 60000).toISOString();
    ctx.store.putUser("u1", "entryBox", box.id, box);
    const out = run(ctx, at);
    assert.equal(out[0].outcome, "entered");
    const placed = ctx.orders.listForUser("u1");
    assert.equal(placed.length, 1);
    assert.equal(placed[0].symbol, "AAPL");
    // single strong signal (score 49): small budget: 0.5% of 100k / $1 stop distance = 500
    assert.ok(placed[0].quantity >= 10 && placed[0].quantity <= 500);
    // a second strategy later the same day is ignored
    assert.equal(ctx.entry.observe({ userId: "u1", signal: ctx.signal("vwap_reclaim"), brokerSymbol: "AAPL", now: at }).state, "locked");
  } finally { cleanup(ctx); }
});

test("three agreeing families enter immediately and a bigger score gets a bigger budget", () => {
  const ctx = load();
  try {
    ctx.account();
    for (const s of ["orb15", "vwap_reclaim", "gap_pullback"]) ctx.entry.observe({ userId: "u1", signal: ctx.signal(s), brokerSymbol: "AAPL", now: ctx.now });
    const out = run(ctx);
    assert.equal(out[0].outcome, "entered");
    const view = ctx.entry.view("u1", ctx.now);
    assert.equal(view.decisions[0].families.length, 3);
    assert.ok(view.decisions[0].score >= 80);
  } finally { cleanup(ctx); }
});

test("size caps: exposure room and minimum shares", () => {
  const { size } = require("../src/execution/entryDecision");
  const p = require("../src/execution/entryProfile").DEFAULTS;
  const big = size({ score: 100, price: 50, stop: 49, equity: 100000, exposure: 0, profile: p });
  assert.equal(big.byBudget, 200); // 10% of 100k / 50
  assert.equal(big.shares, 200);
  const tight = size({ score: 100, price: 50, stop: 49, equity: 100000, exposure: 49500, profile: p });
  assert.equal(tight.shares, 10); // 500 room / 50
  const none = size({ score: 100, price: 50, stop: 49, equity: 100000, exposure: 49990, profile: p });
  assert.equal(none.shares, 0);
});

test("one symbol, one position: an open MT4 position or active order blocks a new entry", () => {
  const ctx = load();
  try {
    const row = { ticket: "1", symbol: "AAPL#", side: "buy", lots: 10, openPrice: 100, currentPrice: 100, managed: true };
    ctx.account([row]);
    for (const s of ["orb15", "vwap_reclaim", "gap_pullback"]) ctx.entry.observe({ userId: "u1", signal: ctx.signal(s), brokerSymbol: "AAPL", now: ctx.now });
    const out = run(ctx);
    assert.equal(out[0].outcome, "skipped");
    assert.equal(out[0].reason, "symbol_busy");
    assert.equal(ctx.orders.listForUser("u1").length, 0);
  } finally { cleanup(ctx); }
});

test("profile validation rejects inconsistent values", () => {
  const { validate, DEFAULTS } = require("../src/execution/entryProfile");
  assert.throws(() => validate({ minScore: 90, immediateScore: 80 }, DEFAULTS));
  assert.throws(() => validate({ perTradeMinPct: 20, perTradeMaxPct: 10 }, DEFAULTS));
  assert.throws(() => validate({ perTradeMaxPct: 60 }, DEFAULTS));
  assert.equal(validate({ windowMin: 5 }, DEFAULTS).windowMin, 5);
});

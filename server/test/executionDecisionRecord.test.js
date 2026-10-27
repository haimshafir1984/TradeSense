const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODULES = [
  "../src/autopilot/store", "../src/autopilot/market", "../src/execution/positions", "../src/execution/orders",
  "../src/execution/riskProfile", "../src/execution/risk", "../src/execution/bridge", "../src/execution/entryProfile",
  "../src/execution/entryDecision", "../src/execution/pnlHistory", "../src/execution/decisionFeed",
  "../src/execution/exitLog", "../src/execution/outcomes",
];

// Temporary database and unique profile ids, so earlier runs cannot leak into the assertions.
function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-record-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "r.sqlite");
  process.env.EXECUTION_QUEUE_ENABLED = "true";
  process.env.EXECUTION_BROKER_ACCOUNT_ID = "102992";
  for (const name of MODULES) delete require.cache[require.resolve(name)];
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = { scratch, now: Date.now(), a: `rec-a-${tag}`, b: `rec-b-${tag}` };
  ctx.store = require("../src/autopilot/store");
  ctx.entry = require("../src/execution/entryDecision");
  ctx.feed = require("../src/execution/decisionFeed").feed;
  ctx.orders = require("../src/execution/orders");
  const positions = require("../src/execution/positions");
  const riskProfile = require("../src/execution/riskProfile");
  positions.save({ accountId: "102992", isDemo: true, currency: "USD", balance: 100000, equity: 100000, profit: 0, positions: [], closedDeals: [] }, ctx.now);
  riskProfile.ensureDayBase(ctx.now);
  for (const id of [ctx.a, ctx.b]) ctx.store.put("user", id, { id, createdAt: new Date(ctx.now).toISOString() });
  ctx.signal = (strategy) => ({
    id: `d:AAPL:${strategy}:${ctx.a}`, ticker: "AAPL", strategy, side: "buy", status: "active", entry: 100, maxEntry: 100.5, stop: 99, target: 103,
    rvol: 2.5, daily: { atr14: 1.5, avgDollarVolume20d: 80e6 }, expiresAt: new Date(ctx.now + 600000).toISOString(),
  });
  // Three agreeing families decide immediately, as the engine does right after recording a signal.
  ctx.enter = (userId) => {
    for (const s of ["orb15", "vwap_reclaim", "gap_pullback"]) ctx.entry.observe({ userId, signal: ctx.signal(s), brokerSymbol: "AAPL", now: ctx.now });
    return ctx.entry.flush({ userId, brokerAccountId: "102992", now: ctx.now });
  };
  return ctx;
}
const cleanup = (ctx) => { ctx.store.close?.(); fs.rmSync(ctx.scratch, { recursive: true, force: true }); };

test("an automatic entry appears in the decision feed and in the entry view", () => {
  const ctx = load();
  try {
    assert.equal(ctx.enter(ctx.a)[0].outcome, "entered");
    assert.ok(ctx.entry.view(ctx.a, ctx.now).decisions.some((d) => d.outcome === "entered"));
    const rows = ctx.feed(ctx.a, 50).filter((r) => r.symbol === "AAPL");
    assert.ok(rows.some((r) => r.outcome === "entered"), "feed has no entered row");
  } finally { cleanup(ctx); }
});

test("when a second profile is blocked by the first one's order, it still sees the entry", () => {
  const ctx = load();
  try {
    assert.equal(ctx.enter(ctx.a)[0].outcome, "entered");
    const second = ctx.enter(ctx.b);
    assert.equal(second[0].reason, "symbol_busy");
    for (const rows of [ctx.feed(ctx.b, 50), ctx.entry.view(ctx.b, ctx.now).decisions]) {
      const entered = rows.filter((r) => r.symbol === "AAPL" && r.outcome === "entered");
      assert.equal(entered.length, 1, "blocked profile cannot see which entry blocked it");
      assert.equal(entered[0].otherProfile, true);
    }
    // the entering profile does not see its own row twice
    assert.equal(ctx.feed(ctx.a, 50).filter((r) => r.outcome === "entered").length, 1);
    // one account order only
    assert.equal(ctx.orders.listAll().filter((o) => o.symbol === "AAPL").length, 1);
  } finally { cleanup(ctx); }
});

test("outcome ledger finds the entry decision of an order", () => {
  const ctx = load();
  try {
    ctx.enter(ctx.a);
    const order = ctx.orders.listAll().find((o) => o.symbol === "AAPL");
    assert.equal(ctx.entry.view(ctx.a, ctx.now).decisions.find((d) => d.outcome === "entered").orderId, order.id);
    assert.equal(require("../src/execution/outcomes").findDecision(order)?.orderId, order.id);
  } finally { cleanup(ctx); }
});

test("a failing log write after the order is queued still ends as entered, not skipped", () => {
  const ctx = load();
  try {
    const real = ctx.store.putUser;
    let failed = 0;
    ctx.store.putUser = (u, kind, id, body) => {
      if (kind === ctx.entry.LOG && body.outcome === "entered") { failed++; throw new Error("disk busy"); }
      return real(u, kind, id, body);
    };
    const out = ctx.enter(ctx.a);
    ctx.store.putUser = real;
    assert.equal(failed, 1);
    assert.equal(out[0].outcome, "entered");
    assert.equal(ctx.orders.listAll().filter((o) => o.symbol === "AAPL").length, 1);
    assert.equal(ctx.store.listUser(ctx.a, "entryBox")[0].state, "entered");
    assert.equal(ctx.entry.observe({ userId: ctx.a, signal: ctx.signal("reversal5"), brokerSymbol: "AAPL", now: ctx.now }).state, "locked");
    assert.ok(!ctx.entry.view(ctx.a, ctx.now).decisions.some((d) => d.outcome === "skipped"));
  } finally { cleanup(ctx); }
});

test("pushOnlyBought keeps the activity log but pushes only entries", () => {
  const ctx = load();
  try {
    // web-push is not needed to test the filter and may not be installed in the dev environment
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function (request, ...rest) { return request === "web-push" ? {} : load.call(this, request, ...rest); };
    const notices = require("../src/autopilot/notifications");
    Module._load = load;
    const settings = require("../src/autopilot/settings");
    const ids = (kind) => ctx.store.listUser(ctx.a, kind).map((x) => x.id);
    notices.event(ctx.a, "n1", "signal", "x");
    assert.deepEqual(ids("outbox"), ["n1"]); // default: everything is pushed
    settings.save({ pushOnlyBought: true }, ctx.a);
    notices.event(ctx.a, "n2", "signal", "x");
    notices.event(ctx.a, "n3", "bought", "x", "signal", { bought: true });
    assert.deepEqual(ids("outbox").sort(), ["n1", "n3"]);
    assert.deepEqual(ids("event").sort(), ["n1", "n2", "n3"]);
    assert.throws(() => settings.save({ pushOnlyBought: "yes" }, ctx.a));
  } finally { cleanup(ctx); }
});

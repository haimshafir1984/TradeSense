const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-risk-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "risk.sqlite");
  for (const name of ["../src/autopilot/store", "../src/execution/risk", "../src/execution/riskProfile", "../src/autopilot/settings", "../src/autopilot/market", "../src/execution/positions"]) delete require.cache[require.resolve(name)];
  return { scratch, store: require("../src/autopilot/store"), risk: require("../src/execution/risk"), profile: require("../src/execution/riskProfile"), positions: require("../src/execution/positions") };
}

function close(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

function signal(overrides = {}) {
  return {
    id: "signal-1", status: "active", brokerSymbol: "COLMEX.AAPL", expiresAt: new Date(Date.now() + 600000).toISOString(),
    entry: 100, stop: 98, target: 104, sizing: { shares: 2 }, side: "buy", ...overrides,
  };
}

function freshAccount(ctx, now = Date.now()) {
  ctx.positions.save({ accountId: "demo", isDemo: true, balance: 10000, equity: 10000, profit: 0, positions: [] }, now);
  ctx.profile.ensureDayBase(now);
}

test("risk gate rejects unmapped broker symbols and accepts a bounded demo intent", () => {
  const ctx = load();
  try {
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "AAPL", signal: signal({ brokerSymbol: null }) }), /מיפוי/);
    freshAccount(ctx);
    const result = ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() });
    assert.equal(result.quantity, 2);
  } finally { close(ctx); }
});

test("risk gate fails closed without fresh MT4 data and blocks entries at the concurrency limit", () => {
  const ctx = load();
  try {
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() }), /עדכני/);
    freshAccount(ctx);
    ctx.profile.save({ maxConcurrent: 3 });
    ctx.store.put("executionOrder", "existing", { id: "existing", status: "pending", symbol: "OTHER0", brokerAccountId: "demo" });
    ctx.store.put("executionOrder", "existing-2", { id: "existing-2", status: "claimed", symbol: "OTHER1", brokerAccountId: "demo" });
    ctx.store.put("executionOrder", "existing-3", { id: "existing-3", status: "submitted", symbol: "OTHER2", brokerAccountId: "demo" });
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() }), /במקביל/);
  } finally { close(ctx); }
});

test("one symbol, one position holds across users and for orders just filled", () => {
  const ctx = load();
  try {
    freshAccount(ctx);
    const base = { userId: "user-2", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() };
    ctx.store.put("executionOrder", "o1", { id: "o1", userId: "user-1", status: "pending", symbol: "COLMEX.AAPL", brokerAccountId: "demo" });
    assert.throws(() => ctx.risk.validateSignal(base), /פקודה פעילה/);
    ctx.store.put("executionOrder", "o1", { id: "o1", userId: "user-1", status: "filled", symbol: "COLMEX.AAPL", brokerAccountId: "demo", completedAt: new Date().toISOString() });
    assert.throws(() => ctx.risk.validateSignal(base), /פקודה פעילה/);
    ctx.store.put("executionOrder", "o1", { id: "o1", userId: "user-1", status: "filled", symbol: "COLMEX.AAPL", brokerAccountId: "demo", completedAt: new Date(Date.now() - 600000).toISOString() });
    assert.equal(ctx.risk.validateSignal(base).quantity, 2);
  } finally { close(ctx); }
});

test("autonomous mode left running fixes a missing day base on the first fresh report", () => {
  const ctx = load();
  try {
    const now = Date.now();
    ctx.positions.save({ accountId: "demo", isDemo: true, balance: 10000, equity: 10000, profit: 0, positions: [] }, now);
    // Not autonomous and no base: still rejected.
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal(), now }), /בסיס/);
    ctx.store.put("runtime", "execution-control", { mode: "autonomous", changedAt: new Date(now).toISOString() });
    ctx.store.put("runtime", "execution-agent", { agentId: "t", accountId: "demo", isDemo: true, lastSeenAt: new Date(now).toISOString() });
    const result = ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal(), now });
    assert.equal(result.quantity, 2);
    assert.equal(ctx.profile.evaluateDay(now).hasBase, true);
  } finally { close(ctx); }
});

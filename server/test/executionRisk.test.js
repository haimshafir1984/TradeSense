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
    ctx.store.putUser("user-1", "executionOrder", "existing", { id: "existing", status: "pending" });
    ctx.store.putUser("user-1", "executionOrder", "existing-2", { id: "existing-2", status: "claimed" });
    ctx.store.putUser("user-1", "executionOrder", "existing-3", { id: "existing-3", status: "submitted" });
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() }), /במקביל/);
  } finally { close(ctx); }
});

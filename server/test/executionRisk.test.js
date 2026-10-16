const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-risk-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "risk.sqlite");
  for (const name of ["../src/autopilot/store", "../src/execution/risk", "../src/autopilot/settings", "../src/autopilot/market"]) delete require.cache[require.resolve(name)];
  return { scratch, store: require("../src/autopilot/store"), risk: require("../src/execution/risk") };
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

test("risk gate rejects unmapped broker symbols and accepts a bounded demo intent", () => {
  const ctx = load();
  try {
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "AAPL", signal: signal({ brokerSymbol: null }) }), /מיפוי/);
    const result = ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() });
    assert.equal(result.quantity, 2);
  } finally { close(ctx); }
});

test("risk gate blocks a second position at the configured limit", () => {
  const ctx = load();
  try {
    ctx.store.putUser("user-1", "executionOrder", "existing", { id: "existing", status: "pending" });
    ctx.store.putUser("user-1", "executionOrder", "existing-2", { id: "existing-2", status: "claimed" });
    ctx.store.putUser("user-1", "executionOrder", "existing-3", { id: "existing-3", status: "submitted" });
    assert.throws(() => ctx.risk.validateSignal({ userId: "user-1", brokerAccountId: "demo", symbol: "COLMEX.AAPL", signal: signal() }), /מספר הפוזיציות/);
  } finally { close(ctx); }
});

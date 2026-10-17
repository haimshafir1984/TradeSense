const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-positions-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "positions.sqlite");
  delete require.cache[require.resolve("../src/autopilot/store")];
  delete require.cache[require.resolve("../src/execution/positions")];
  const store = require("../src/autopilot/store");
  const positions = require("../src/execution/positions");
  return { scratch, store, positions };
}

function close(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

test("reports unavailable before the EA has sent anything", () => {
  const ctx = load();
  try {
    assert.deepEqual(ctx.positions.current(), { available: false, fresh: false, positions: [] });
  } finally {
    close(ctx);
  }
});

test("stores a snapshot and marks it fresh, then stale", () => {
  const ctx = load();
  try {
    const now = 1700000000000;
    ctx.positions.save(
      {
        accountId: "102992",
        isDemo: true,
        currency: "USD",
        balance: 10000,
        equity: 9997.3,
        profit: -2.7,
        positions: [{ ticket: 20109734, symbol: "Apple#", side: "buy", lots: 10, openPrice: 341.9, currentPrice: 341.6, stopLoss: 328.22, takeProfit: 355.58, profit: -2.7, managed: true }],
      },
      now,
    );
    const fresh = ctx.positions.current(now + 30_000);
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.positions[0].ticket, "20109734");
    assert.equal(fresh.positions[0].managed, true);
    assert.equal(ctx.positions.current(now + 120_000).fresh, false);
  } finally {
    close(ctx);
  }
});

test("rejects a snapshot without an account or with a non-numeric price", () => {
  const ctx = load();
  try {
    assert.throws(() => ctx.positions.save({ positions: [] }), /חשבון MT4 חסר/);
    assert.throws(() => ctx.positions.save({ accountId: "1", positions: [{ ticket: 1, symbol: "X", side: "buy", lots: 1, openPrice: "abc" }] }), /openPrice/);
  } finally {
    close(ctx);
  }
});

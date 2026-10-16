const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-orders-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "orders.sqlite");
  delete require.cache[require.resolve("../src/autopilot/store")];
  delete require.cache[require.resolve("../src/execution/orders")];
  const store = require("../src/autopilot/store");
  const orders = require("../src/execution/orders");
  return { scratch, store, orders };
}

function close(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

test("creates a pending order with lifecycle timestamps", () => {
  const ctx = load();
  try {
    const result = ctx.orders.create({ symbol: "AAPL", side: "buy", quantity: 2, idempotencyKey: "signal-1" }, "user-1", 1700000000000);
    assert.equal(result.duplicate, false);
    assert.equal(result.order.status, "pending");
    assert.equal(result.order.symbol, "AAPL");
    assert.equal(result.order.createdAt, "2023-11-14T22:13:20.000Z");
    assert.equal(result.order.updatedAt, result.order.createdAt);
  } finally { close(ctx); }
});

test("idempotency prevents duplicate order creation", () => {
  const ctx = load();
  try {
    const input = { symbol: "AAPL", side: "buy", quantity: 2, idempotencyKey: "same-request" };
    const first = ctx.orders.create(input, "user-1");
    const second = ctx.orders.create(input, "user-1");
    assert.equal(second.duplicate, true);
    assert.equal(second.order.id, first.order.id);
    assert.equal(ctx.orders.listForUser("user-1").length, 1);
  } finally { close(ctx); }
});

test("lifecycle rejects invalid transitions and stores broker errors", () => {
  const ctx = load();
  try {
    const created = ctx.orders.create({ symbol: "AAPL", side: "buy", quantity: 2 }, "user-1").order;
    const claimed = ctx.orders.transition(created.id, "claimed");
    assert.equal(claimed.status, "claimed");
    const submitted = ctx.orders.transition(created.id, "submitted", { brokerOrderId: "mt4-7" });
    assert.equal(submitted.brokerOrderId, "mt4-7");
    const repeated = ctx.orders.transition(created.id, "submitted", { brokerOrderId: "mt4-7", filledQuantity: 0 });
    assert.equal(repeated.brokerOrderId, "mt4-7");
    const rejected = ctx.orders.transition(created.id, "rejected", { error: "broker rejected" });
    assert.equal(rejected.error, "broker rejected");
    assert.throws(() => ctx.orders.transition(created.id, "filled"), /מעבר אסור/);
  } finally { close(ctx); }
});

test("executor token is fail-closed when not configured", () => {
  const ctx = load();
  try {
    delete process.env.EXECUTION_AGENT_TOKEN;
    assert.equal(ctx.orders.canUseExecutorToken("anything"), false);
    process.env.EXECUTION_AGENT_TOKEN = "secret-token";
    assert.equal(ctx.orders.canUseExecutorToken("secret-token"), true);
    assert.equal(ctx.orders.canUseExecutorToken("wrong"), false);
  } finally { delete process.env.EXECUTION_AGENT_TOKEN; close(ctx); }
});

test("signal bridge persists intent only and is idempotent", () => {
  const ctx = load();
  try {
    delete require.cache[require.resolve("../src/execution/bridge")];
    const bridge = require("../src/execution/bridge");
    const signal = {
      id: "2026-01-01:AAPL:orb15:3.1.0",
      ticker: "AAPL",
      side: "buy",
      strategy: "orb15",
      version: "3.1.0",
      entry: 100,
      maxEntry: 101,
      stop: 98,
      target: 104,
      sizing: { shares: 2 },
    };
    const first = bridge.queueSignal({ userId: "user-1", signal, brokerAccountId: "demo" });
    const second = bridge.queueSignal({ userId: "user-1", signal, brokerAccountId: "demo" });
    assert.equal(first.order.status, "pending");
    assert.equal(first.order.symbol, "AAPL");
    assert.equal(second.duplicate, true);
    assert.equal(ctx.orders.listForUser("user-1").length, 1);
  } finally { close(ctx); }
});

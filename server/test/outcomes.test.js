const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/autopilot/store");
const orders = require("../src/execution/orders");
const outcomes = require("../src/execution/outcomes");
const positions = require("../src/execution/positions");

test("closed deal is linked to order and entry decision", () => {
  const { order } = orders.create({ symbol: "Apple", side: "buy", quantity: 5, strategy: "orb", idempotencyKey: `t:${Date.now()}` }, "u-out");
  orders.transition(order.id, "claimed");
  orders.transition(order.id, "submitted", { brokerOrderId: "777001" });
  store.putUser("u-out", "entryLog", "x:Apple", { id: "x:Apple", orderId: order.id, strategies: ["orb", "vwap"], score: 63, families: ["a", "b"] });
  const t = Math.floor(Date.now() / 1000);
  const norm = positions.normalize({ accountId: "A", closedDeals: [{ t, p: 12.5, ticket: 777001, symbol: "Apple#", side: "buy", lots: 5, openPrice: 1, closePrice: 2, openT: t - 60 }, { t, p: -3 }] });
  assert.equal(norm.closedDeals[0].ticket, "777001");
  assert.equal(outcomes.record(norm.closedDeals), 1);
  assert.equal(outcomes.record(norm.closedDeals), 0);
  const s = outcomes.summary("u-out");
  assert.equal(s.overall.trades, 1);
  assert.equal(s.byStrategy.orb.total, 12.5);
  assert.equal(s.byScore["60-69"].wins, 1);
});

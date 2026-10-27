const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/autopilot/store");
const exitLog = require("../src/execution/exitLog");
const { feed } = require("../src/execution/decisionFeed");

test("feed merges entry and exit decisions newest first", () => {
  const u = `u-feed-${Date.now()}`;
  const t = Date.now();
  store.putUser(u, "entryDecision", "e1", { id: "e1", at: new Date(t - 5000).toISOString(), symbol: "Apple", outcome: "entered", reasonText: "x" });
  exitLog.recordActions([
    { type: "partial_close", ticket: "5", lots: 10, tiers: [1], commandId: "c" },
    { type: "close", ticket: "5", reason: "eod", commandId: "c2" },
    { type: "modify_stop", ticket: "5", stopLoss: 101.5 },
    { type: "tier_skipped", ticket: "5", note: "הכמות קטנה" },
  ], [{ ticket: "5", symbol: "Apple#" }], t);
  const rows = feed(u, 50).filter((r) => r.symbol === "Apple");
  assert.equal(rows.length, 5);
  assert.equal(rows[rows.length - 1].kind, "entry");
  assert.ok(rows.some((r) => r.outcome === "exit_partial" && r.qty === 10));
  assert.ok(rows.some((r) => r.outcome === "exit_close" && r.reasonText.includes("סוף יום")));
  assert.ok(rows.some((r) => r.outcome === "stop_moved" && r.reasonText.includes("101.5")));
  assert.ok(rows.some((r) => r.outcome === "exit_skipped"));
  assert.equal(feed(u, 2).length, 2);
});

const test = require("node:test");
const assert = require("node:assert");
const log = require("../src/autopilot/sentimentLog");

const body = { messages: [
  { created_at: "2026-10-20T14:00:00Z", entities: { sentiment: { basic: "Bullish" } } },
  { created_at: "2026-10-20T14:10:00Z", entities: { sentiment: { basic: "Bullish" } } },
  { created_at: "2026-10-20T14:20:00Z", entities: { sentiment: { basic: "Bearish" } } },
  { created_at: "2026-10-20T14:30:00Z", entities: { sentiment: null } },
] };

test("summarize counts tagged sides and net score", () => {
  const now = Date.parse("2026-10-20T14:40:00Z");
  const s = log.summarize("AAPL", body, now);
  assert.equal(s.messages, 4);
  assert.equal(s.bullish, 2);
  assert.equal(s.bearish, 1);
  assert.equal(s.net, 33);
  assert.equal(s.spanMin, 30);
  assert.equal(s.ageMin, 10);
  assert.equal(log.summarize("X", { messages: [] }, now).net, null);
});

test("collect stores samples, records http errors, and respects the budget", async () => {
  const now = Date.parse("2026-10-20T14:40:00Z");
  const ok = await log.collect("ZZTEST", { now, fetchImpl: async () => ({ ok: true, json: async () => body }) });
  assert.equal(ok.net, 33);
  const bad = await log.collect("ZZTEST", { now, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(bad.error, "http_403");
  assert.ok(log.read("2026-10-20").symbols.ZZTEST.length >= 2);
  log._spent.length = 0;
  for (let i = 0; i < 150; i++) log._spent.push(now);
  const blocked = await log.fetchSample("ZZTEST", { now, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(blocked.error, "budget");
  log._spent.length = 0;
});

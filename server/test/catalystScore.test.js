const test = require("node:test");
const assert = require("node:assert");
const cache = require("../src/execution/catalystCache");
const { score } = require("../src/execution/entryDecision");
const profile = require("../src/execution/entryProfile").DEFAULTS;

test("catalyst points: surprise helps, pending report and unexplained gap hurt, capped", () => {
  assert.equal(cache.points({ kind: "earnings_surprise", earningsSurprisePct: 12 }).pts, 6);
  assert.equal(cache.points({ kind: "earnings_surprise", earningsSurprisePct: -5 }).pts, -6);
  assert.equal(cache.points({ kind: "earnings_scheduled" }).pts, -4);
  assert.equal(cache.points({ kind: "news_spike" }).pts, 3);
  assert.equal(cache.points({ kind: "gap_no_news" }).pts, -3);
  assert.equal(cache.points({ kind: "earnings_surprise", earningsSurprisePct: 12 }, 2).pts, 2);
  assert.equal(cache.points(null).pts, 0);
  assert.equal(cache.points({ kind: null }).pts, 0);
});

test("score adds the catalyst adjustment and a note, and is unchanged without catalyst", () => {
  const sig = [{ strategy: "orb", rvol: 1 }];
  const plain = score(sig, profile);
  const withCat = score(sig, profile, { kind: "news_spike" });
  assert.equal(withCat.score, plain.score + 3);
  assert.ok(withCat.notes.some((n) => n.includes("חדשות")));
  assert.equal(score(sig, profile, null).score, plain.score);
});

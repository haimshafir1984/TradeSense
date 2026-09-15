const test = require("node:test");
const assert = require("node:assert/strict");
const universe = require("../src/autopilot/universe");
const market = require("../src/autopilot/market");
const selection = require("../src/autopilot/selection");

function bucketRows(prefix, count, adv) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `${prefix}${String(index).padStart(4, "0")}`,
    avgDollarVolume20d: adv + index,
  }));
}

test("balanced universe allocates exact 600/800/600 quotas without duplicate symbols", () => {
  const rows = [
    ...bucketRows("L", 800, 2_000_001),
    ...bucketRows("M", 1500, 20_000_001),
    ...bucketRows("H", 1200, 100_000_001),
  ];
  const result = universe.stratify(rows, 2000);
  assert.deepEqual(result.quotas, { lower_liquidity: 600, medium_liquidity: 800, high_liquidity: 600 });
  assert.deepEqual(Object.fromEntries(Object.entries(result.perBucket).map(([key, value]) => [key, value.selected])), result.quotas);
  assert.equal(result.rows.length, 2000);
  assert.equal(new Set(result.rows.map((row) => row.symbol)).size, 2000);
});

test("largest-remainder quotas sum exactly and deficits redistribute deterministically", () => {
  assert.deepEqual(universe.quotas(7), { lower_liquidity: 2, medium_liquidity: 3, high_liquidity: 2 });
  const rows = [...bucketRows("M", 10, 20_000_001)];
  const first = universe.stratify(rows, 7);
  const second = universe.stratify(rows, 7);
  assert.deepEqual(first.rows.map((row) => row.symbol), second.rows.map((row) => row.symbol));
  assert.equal(first.rows.length, 7);
  assert.equal(new Set(first.rows.map((row) => row.symbol)).size, 7);
});

test("delayed SIP cutoff uses wall clock, floors to five minutes, and rejects the bar starting at end", () => {
  const wallNow = Date.parse("2026-09-15T14:02:00.000Z"); // 10:02 New York (EDT)
  const cutoff = market.delayedSipCutoff(wallNow);
  assert.equal(new Date(cutoff).toISOString(), "2026-09-15T13:45:00.000Z");
  assert.equal(market.acceptDelayedSipBar({ t: "2026-09-15T13:40:00.000Z" }, cutoff), true);
  assert.equal(market.acceptDelayedSipBar({ t: "2026-09-15T13:45:00.000Z" }, cutoff), false);
});

test("delayed SIP RVOL requires at least 15 completed session minutes", () => {
  const open = Date.parse("2026-09-15T13:30:00.000Z");
  const today = { date: "2026-09-15", open, close: Date.parse("2026-09-15T20:00:00.000Z") };
  const prior = Array.from({ length: 5 }, (_, index) => {
    const day = 14 - index;
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    const priorOpen = Date.parse(`${date}T13:30:00.000Z`);
    return { date, open: priorOpen, close: priorOpen + 6.5 * 3600000 };
  });
  const calendar = [...prior, today];
  const tooEarly = Date.parse("2026-09-15T13:35:00.000Z");
  assert.equal(market.delayedSipOpeningRvol([], calendar, today, Date.parse("2026-09-15T13:55:00Z"), tooEarly), null);
});

test("balanced admits daily-qualified swing rows without a fresh snapshot, while legacy/day remain fail-closed", () => {
  const profile = process.env.AUTOPILOT_SCAN_PROFILE;
  delete process.env.AUTOPILOT_SCAN_PROFILE;
  const row = { symbol: "SWING", close: 25, exchange: "NASDAQ", avgDollarVolume20d: 30_000_000 };
  const daily = { price: 25, ma200: 20, return5d: -6, rsi14: 30, avgDollarVolume20d: 30_000_000 };
  const common = { rows: [row], snapshots: new Map(), dailyFeatures: new Map([[row.symbol, { features: daily }]]), rvolScores: new Map(), calendar: [], today: { date: "2026-09-15" }, now: Date.parse("2026-09-15T14:00:00Z") };
  const balanced = selection.selectCandidates({ ...common, activeStrategies: ["reversal5"] });
  assert.equal(balanced.selected.some((item) => item.symbol === row.symbol && item.eligibleStrategies.includes("reversal5")), true);
  process.env.AUTOPILOT_SCAN_PROFILE = "legacy";
  const legacy = selection.selectCandidates({ ...common, activeStrategies: ["reversal5"] });
  assert.equal(legacy.selected.some((item) => item.eligibleStrategies?.includes("reversal5")), false);
  if (profile === undefined) delete process.env.AUTOPILOT_SCAN_PROFILE; else process.env.AUTOPILOT_SCAN_PROFILE = profile;
});

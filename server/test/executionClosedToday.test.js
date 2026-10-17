const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-closed-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "closed.sqlite");
  for (const m of ["../src/autopilot/store", "../src/execution/positions"]) delete require.cache[require.resolve(m)];
  return { scratch, store: require("../src/autopilot/store"), positions: require("../src/execution/positions") };
}
function done(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

// Saturday 2026-10-17 12:40 UTC (market closed). Friday's deals must not count as "today".
const SAT = Date.parse("2026-10-17T12:40:00Z");
const base = { accountId: "102992", isDemo: true, balance: 100000, equity: 100000, profit: 0, positions: [] };
const sec = (iso) => Date.parse(iso) / 1000;

test("a deal closed on Friday is not today's result on Saturday", () => {
  const ctx = load();
  try {
    ctx.positions.save({ ...base, closedDeals: [{ t: sec("2026-10-16T18:00:00Z"), p: -40 }, { t: sec("2026-10-15T15:00:00Z"), p: 10 }] }, SAT);
    const snap = ctx.positions.current(SAT + 10_000);
    assert.equal(snap.closedToday, 0);
    assert.equal(snap.closedDeals, undefined);
  } finally { done(ctx); }
});

test("deals are assigned to the New York date, including across New York midnight", () => {
  const ctx = load();
  try {
    const now = Date.parse("2026-10-19T14:00:00Z"); // Monday 10:00 New York
    ctx.positions.save({
      ...base,
      closedDeals: [
        { t: sec("2026-10-19T03:59:00Z"), p: -5 }, // Sunday 23:59 New York
        { t: sec("2026-10-19T04:01:00Z"), p: 7 }, // Monday 00:01 New York
        { t: sec("2026-10-19T13:35:00Z"), p: 3 },
      ],
    }, now);
    assert.equal(ctx.positions.current(now + 1000).closedToday, 10);
  } finally { done(ctx); }
});

test("without deal data (old EA or unknown broker clock) nothing is claimed", () => {
  const ctx = load();
  try {
    ctx.positions.save({ ...base, closedToday: -40 }, SAT);
    assert.equal(ctx.positions.current(SAT + 1000).closedToday, null);
  } finally { done(ctx); }
});

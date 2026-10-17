const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-pnl-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "pnl.sqlite");
  for (const m of ["../src/autopilot/store", "../src/execution/positions", "../src/execution/pnlHistory"]) delete require.cache[require.resolve(m)];
  return { scratch, store: require("../src/autopilot/store"), positions: require("../src/execution/positions"), pnl: require("../src/execution/pnlHistory") };
}
function done(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}
const sec = (iso) => Date.parse(iso) / 1000;
const base = { accountId: "102992", isDemo: true, balance: 100000, equity: 100000, profit: 0, positions: [] };

test("daily totals accumulate per New York date and roll into week, month, quarter and year", () => {
  const ctx = load();
  try {
    // Wednesday 2026-10-14 .. Friday 2026-10-16 trading, then Monday 2026-10-19 morning.
    const fri = Date.parse("2026-10-16T21:00:00Z");
    ctx.positions.save({ ...base, closedDeals: [{ t: sec("2026-10-14T15:00:00Z"), p: 30 }, { t: sec("2026-10-15T15:00:00Z"), p: -10 }, { t: sec("2026-10-16T15:00:00Z"), p: 5 }, { t: sec("2026-10-16T16:00:00Z"), p: -2 }] }, fri);
    const mon = Date.parse("2026-10-19T15:00:00Z");
    ctx.positions.save({ ...base, closedDeals: [{ t: sec("2026-10-19T14:00:00Z"), p: 8 }, { t: sec("2026-10-16T16:00:00Z"), p: -2 }] }, mon);
    const s = ctx.pnl.summary(mon + 1000);
    assert.equal(s.periods.day.pnl, 8);
    assert.equal(s.periods.week.pnl, 8); // new week starts Monday 2026-10-19
    assert.equal(s.periods.month.pnl, 31); // 30 - 10 + 3 + 8
    assert.equal(s.periods.quarter.pnl, 31);
    assert.equal(s.periods.year.pnl, 31);
    const lastWeek = ctx.pnl.summary(fri + 1000);
    assert.equal(lastWeek.periods.week.pnl, 23);
    assert.equal(lastWeek.periods.week.wins, 2);
    assert.equal(lastWeek.periods.week.losses, 2);
  } finally { done(ctx); }
});

test("a partially visible old day never overwrites its complete record", () => {
  const ctx = load();
  try {
    const wed = Date.parse("2026-10-14T21:00:00Z");
    ctx.positions.save({ ...base, closedDeals: [{ t: sec("2026-10-14T15:00:00Z"), p: 30 }, { t: sec("2026-10-14T16:00:00Z"), p: 20 }] }, wed);
    const later = Date.parse("2026-10-19T15:00:00Z");
    ctx.positions.save({ ...base, closedDeals: [{ t: sec("2026-10-14T16:00:00Z"), p: 20 }] }, later); // Oct 14 is now outside the safe window
    assert.equal(ctx.pnl.summary(later).periods.week.pnl, 0);
    assert.equal(ctx.pnl.summary(wed + 1000).periods.day.pnl, 50);
    assert.equal(ctx.pnl.summary(later).periods.month.pnl, 50);
  } finally { done(ctx); }
});

test("quarter and year boundaries, and no data", () => {
  const ctx = load();
  try {
    assert.equal(ctx.pnl.summary(Date.parse("2026-10-17T12:00:00Z")).daysRecorded, 0);
    assert.equal(ctx.pnl.quarterStart("2026-11-20"), "2026-10-01");
    assert.equal(ctx.pnl.quarterStart("2026-03-31"), "2026-01-01");
    assert.equal(ctx.pnl.weekStart("2026-10-17"), "2026-10-12"); // Saturday belongs to the Mon-Fri week before
  } finally { done(ctx); }
});

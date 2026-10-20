const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-pm-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "p.sqlite");
  for (const m of ["../src/autopilot/store", "../src/autopilot/market", "../src/autopilot/premarketLog"]) delete require.cache[require.resolve(m)];
  return { scratch, log: require("../src/autopilot/premarketLog") };
}

test("a sample computes the gap and counts symbols that had a trade", () => {
  const { scratch, log } = load();
  try {
    const now = Date.parse("2026-10-20T12:30:00Z");
    const snaps = new Map([["AAPL", { latestTrade: { p: 102, t: "2026-10-20T12:29:00Z" }, prevDailyBar: { c: 100 }, minuteBar: { v: 500 } }], ["TSLA", {}]]);
    const doc = log.sample(snaps, ["AAPL", "TSLA", "MSFT"], now);
    assert.equal(doc.requested, 3);
    assert.equal(doc.withTrade, 1);
    assert.equal(doc.rows[0].gapPct, 2);
    assert.equal(doc.rows[1].last, null);
    log.save(doc);
    const back = log.list("2026-10-20");
    assert.equal(back.length, 1);
    assert.equal(back[0].rows.length, 3);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("due only fires inside the 90 minutes before the open, once per 5 minutes", () => {
  const { scratch, log } = load();
  try {
    const open = Date.parse("2026-10-20T13:30:00Z");
    const today = { open };
    assert.equal(log.due(open - 2 * 3600000, today), false);
    assert.equal(log.due(open - 3600000, today), true);
    assert.equal(log.due(open - 3500000, today), false);
    assert.equal(log.due(open + 1000, today), false);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

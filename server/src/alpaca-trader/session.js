// Trading-day calendar for the Alpaca arm: the real open/close of each day, from Alpaca's own calendar (the same
// one the Colmex arm already uses, autopilot/market.js sessions()). Before this, 09:30 / 15:55 / 16:00 were fixed in the code,
// so on a shortened day (13:00 close, e.g. the Friday after Thanksgiving, 2026-11-27) the end-of-day close would have been
// sent into a closed market and queued for the next open - the same failure as 2026-11-10.
//
// The helpers are synchronous (the callers are); `ensure()` loads the calendar asynchronously and is awaited at the start
// of every scan and exit tick. If the calendar is unavailable the fixed regular-day hours are used, which is no worse
// than the previous behaviour.
const market = require("../autopilot/market");

const { nyDate, nyTimestamp } = market;
const EOD_BUFFER_MS = 5 * 60000; // the end-of-day close goes out this long before the real close
const RETRY_AFTER_MS = 5 * 60000;

let table = null; // Map date -> { open, close } (trading days only)
let range = null; // { from, to } the calendar covers; a weekday inside it that is not in the table is a holiday
let loadedFor = null; // NY date the table was last loaded for
let failedAt = 0;
const PRELOADED = "*";

async function ensure(now = Date.now()) {
  const today = nyDate(now);
  if (loadedFor === PRELOADED || (loadedFor === today && table)) return;
  if (failedAt && now - failedAt < RETRY_AFTER_MS) return;
  try {
    const rows = (await market.sessions(now)).slice().sort((a, b) => a.open - b.open);
    if (!rows.length) throw new Error("empty calendar");
    table = new Map(rows.map((row) => [row.date, { open: row.open, close: row.close }]));
    range = { from: rows[0].date, to: rows[rows.length - 1].date };
    loadedFor = today;
    failedAt = 0;
  } catch (error) {
    failedAt = now;
    console.warn(`[alpaca-trader] trading calendar unavailable, using regular hours: ${error.message}`);
  }
}

function sessionFor(now = Date.now()) {
  const date = nyDate(now);
  const day = table?.get(date);
  if (day) {
    return { date, tradingDay: true, open: day.open, close: day.close, early: day.close - day.open < 6.5 * 3600000 - 60000, source: "calendar" };
  }
  if (table && range && date >= range.from && date <= range.to) {
    return { date, tradingDay: false, open: null, close: null, early: false, source: "calendar" }; // weekend or exchange holiday
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, tradingDay: weekday >= 1 && weekday <= 5, open: nyTimestamp(date, "09:30"), close: nyTimestamp(date, "16:00"), early: false, source: "fallback" };
}

function inSession(now = Date.now()) {
  const s = sessionFor(now);
  return s.tradingDay && now >= s.open && now < s.close;
}

function isPastClose(now = Date.now()) {
  const s = sessionFor(now);
  return s.tradingDay && now >= s.close - EOD_BUFFER_MS;
}

// For tests: forget the loaded calendar / preload one.
function reset() {
  table = null;
  range = null;
  loadedFor = null;
  failedAt = 0;
}

function load(rows) {
  const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  table = new Map(sorted.map((row) => [row.date, { open: nyTimestamp(row.date, row.open.slice(0, 5)), close: nyTimestamp(row.date, row.close.slice(0, 5)) }]));
  range = { from: sorted[0].date, to: sorted[sorted.length - 1].date };
  loadedFor = PRELOADED; // tests preload: ensure() keeps this table and never calls the network
}

module.exports = { ensure, sessionFor, inSession, isPastClose, reset, load, EOD_BUFFER_MS };

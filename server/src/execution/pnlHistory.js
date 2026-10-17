const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");

// Realized profit/loss per New York trading day, accumulated from the closed deals the EA reports.
// Weeks run Monday to Friday. Only dates fully covered by the EA's four-day history window are written,
// so a day that is partially visible never overwrites a complete record.
const KIND = "executionPnlDay";
const SERIES_DAYS = 30;
const COMPLETE_BACK_MS = 2 * 86400000;

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const weekStart = (date) => addDays(date, -weekday(date));
const quarterStart = (date) => `${date.slice(0, 4)}-${String(Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
const round2 = (v) => Math.round(v * 100) / 100;

function record(deals, now = Date.now()) {
  if (!Array.isArray(deals)) return;
  const earliest = nyDate(now - COMPLETE_BACK_MS);
  const days = new Map();
  for (const d of deals) {
    const date = nyDate(d.t * 1000);
    if (date < earliest) continue;
    const row = days.get(date) || { date, pnl: 0, trades: 0, wins: 0, losses: 0 };
    row.pnl += d.p;
    row.trades += 1;
    if (d.p > 0) row.wins += 1;
    else if (d.p < 0) row.losses += 1;
    days.set(date, row);
  }
  for (const row of days.values()) {
    const next = { ...row, pnl: round2(row.pnl) };
    const saved = store.get(KIND, row.date);
    if (!saved || saved.pnl !== next.pnl || saved.trades !== next.trades || saved.wins !== next.wins || saved.losses !== next.losses) {
      store.put(KIND, row.date, { ...next, updatedAt: new Date(now).toISOString() });
    }
  }
}

function total(rows, from, to) {
  const out = { from, to, pnl: 0, trades: 0, wins: 0, losses: 0 };
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    out.pnl += r.pnl;
    out.trades += r.trades;
    out.wins += r.wins;
    out.losses += r.losses;
  }
  out.pnl = round2(out.pnl);
  return out;
}

function summary(now = Date.now()) {
  const rows = store.list(KIND).filter((r) => r && r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const today = nyDate(now);
  const wk = weekStart(today);
  const periods = {
    day: total(rows, today, today),
    week: total(rows, wk, addDays(wk, 4)),
    month: total(rows, `${today.slice(0, 7)}-01`, `${today.slice(0, 7)}-31`),
    year: total(rows, `${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`),
  };
  const qStart = quarterStart(today);
  const qm = Number(qStart.slice(5, 7));
  const qEnd = `${qStart.slice(0, 4)}-${String(qm + 2).padStart(2, "0")}-31`;
  periods.quarter = total(rows, qStart, qEnd);
  const series = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    if (weekday(date) > 4) continue;
    const hit = rows.find((r) => r.date === date);
    series.push({ date, pnl: hit ? hit.pnl : 0, trades: hit ? hit.trades : 0 });
  }
  const first = rows.length ? rows[0].date : null;
  return { today, periods, series, firstRecordedDate: first, daysRecorded: rows.length };
}

module.exports = { KIND, record, summary, weekStart, quarterStart };

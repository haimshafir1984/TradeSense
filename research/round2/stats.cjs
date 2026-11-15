// Shared statistics for round2: date-block bootstrap, Sharpe, drawdown, concentration. Seeded from the protocol id.
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const std = (xs) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };

function rng(seedText) {
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 7);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// values: array of numbers ordered by date (one per date). One-sided p for H0 "mean <= 0": share of block-bootstrap means <= 0.
function blockP(values, seed, block = 20, n = 2000) {
  const N = values.length;
  if (N < 20) return 1;
  const rand = rng(seed);
  let le = 0;
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    while (cnt < N) { const s = Math.floor(rand() * N); for (let b = 0; b < block && cnt < N; b++, cnt++) sum += values[(s + b) % N]; }
    if (sum / N <= 0) le += 1;
  }
  return Math.max(le / n, 1 / n);
}

function byDate(events) { // [{date, val}] -> sorted [{date, val(mean), n}]
  const m = new Map();
  for (const e of events) (m.get(e.date) || m.set(e.date, []).get(e.date)).push(e.val);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, val: mean(v), n: v.length }));
}

function sharpe(daily) { const s = std(daily); return s > 0 ? (mean(daily) / s) * Math.sqrt(252) : NaN; }

function maxDrawdown(daily) { // compounded equity curve
  let eq = 1, peak = 1, mdd = 0;
  for (const r of daily) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  return mdd;
}

function concentration(dailyWithDates) { // share of total net profit that comes from the best 5% of days
  const vals = dailyWithDates.map((d) => d.val);
  const total = vals.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return null;
  const top = [...vals].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(vals.length * 0.05)));
  return top.reduce((s, x) => s + x, 0) / total;
}

function byYear(dailyWithDates) {
  const years = {};
  for (const d of dailyWithDates) (years[d.date.slice(0, 4)] ||= []).push(d.val);
  return Object.entries(years).map(([year, v]) => ({ year, days: v.length, mean: mean(v) }));
}

const pct = (x, d = 3) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : 'n/a');

module.exports = { mean, std, rng, blockP, byDate, sharpe, maxDrawdown, concentration, byYear, pct };

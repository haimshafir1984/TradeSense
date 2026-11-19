// SHADOW-ONLY signals in the style of two traders (data collection, never traded): "cameron_gap" (Ross Cameron style gap-and-go
// momentum) and "minervini_trend" (Mark Minervini style trend-template breakout). They are evaluated next to the normal strategies,
// recorded in the shadow (and followed for the 5-day hold), and are NOT in settings.strategies, so entry.js never sees them.
// Simplifications, stated honestly: no premarket data (the gap is today's first 5-minute open vs the last daily close), no float,
// and the Minervini template here is the partial one the daily features allow (no MA150, no MA200 slope).
const BAR_MS = 300000;

const finite = (v) => Number.isFinite(Number(v));

// closed = today's closed 5-minute bars ascending; returns [] when the data are stale or missing.
function closedBars(bars, session, barBoundary) {
  const closed = (bars || []).filter((b) => Date.parse(b.t) >= session.open && Date.parse(b.t) + BAR_MS <= barBoundary);
  if (!closed.length) return [];
  if (Date.parse(closed.at(-1).t) + BAR_MS !== barBoundary) return []; // the newest closed candle must be the latest boundary
  return closed;
}

// Gap-and-go: gap of 5% or more at the open, price 2..20 USD, relative volume 2 or more, a green first candle, and the first
// 5-minute close above that candle's high within the first hour. Stop = low of the first candle (skipped when wider than 8%).
function cameron({ closed, session, barBoundary, daily, rvol }) {
  if (closed.length < 2 || !finite(daily?.price) || !finite(rvol)) return null;
  const first = closed[0], last = closed.at(-1);
  if (Date.parse(first.t) !== session.open) return null;
  const minutes = (barBoundary - session.open) / 60000;
  if (minutes < 10 || minutes > 60) return null;
  const gapPct = (Number(first.o) / Number(daily.price) - 1) * 100;
  if (!(gapPct >= 5) || !(rvol >= 2)) return null;
  const entry = Number(last.c);
  if (!(entry >= 2 && entry <= 20)) return null;
  if (!(Number(first.c) > Number(first.o))) return null;
  if (!(entry > Number(first.h))) return null;
  if (closed.slice(1, -1).some((b) => Number(b.c) > Number(first.h))) return null; // only the first breakout
  const stop = Number(first.l), risk = entry - stop;
  if (!(risk > 0) || risk / entry > 0.08) return null;
  return { strategy: "cameron_gap", entry, stop, target: entry + 2 * risk, maxEntry: entry * 1.01, barAt: last.t };
}

// Trend breakout: price above the 50 and 200 day averages with a rising 50-day, 30% above the 52-week low and within 25% of the
// 52-week high, then a first 5-minute close above the previous 20-day high on relative volume 1.5 or more. Stop 7%, target 2R.
function minervini({ closed, barBoundary, session, daily, rvol }) {
  if (!closed.length || !finite(rvol)) return null;
  const d = daily || {};
  if (![d.price, d.ma50, d.ma200, d.ma50Slope, d.high52w, d.low52w, d.high20d].every(finite)) return null;
  if (!(d.price >= 10)) return null;
  if (!(d.price > d.ma50 && d.ma50 > d.ma200 && d.ma50Slope > 0)) return null;
  if (!(d.price >= 1.3 * d.low52w && d.price >= 0.75 * d.high52w)) return null;
  if (!(rvol >= 1.5)) return null;
  if ((barBoundary - session.open) / 60000 < 15) return null;
  const last = closed.at(-1), entry = Number(last.c);
  if (!(entry > d.high20d)) return null;
  if (closed.slice(0, -1).some((b) => Number(b.c) > d.high20d)) return null; // only the first close above the level
  const stop = entry * 0.93;
  return { strategy: "minervini_trend", entry, stop, target: entry + 2 * (entry - stop), maxEntry: entry * 1.01, barAt: last.t };
}

function evaluate({ bars, session, barBoundary, daily, rvol }) {
  const closed = closedBars(bars, session, barBoundary);
  if (!closed.length) return [];
  const args = { closed, session, barBoundary, daily, rvol };
  const out = [];
  for (const fn of [cameron, minervini]) {
    try { const plan = fn(args); if (plan) out.push(plan); } catch { /* data collection only */ }
  }
  return out;
}

module.exports = { evaluate, cameron, minervini, closedBars };

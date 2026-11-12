// Daily equity history for the Alpaca paper account, straight from Alpaca (portfolio history), shaped for the tab's
// equity curve and the per-day table. Read-only and cached: the tab polls every 15 seconds, this changes once a day.
const broker = require("./broker");
const { nyDate } = require("../autopilot/market");

const CACHE_MS = 5 * 60000;
let cache = null;

// Alpaca returns parallel arrays (timestamp in seconds, equity, profit_loss, profit_loss_pct). Days without a value
// (null equity: before the account existed) are dropped.
function shapeHistory(raw) {
  const timestamps = raw?.timestamp || [];
  const days = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const equity = Number(raw.equity?.[i]);
    if (!Number.isFinite(equity) || equity <= 0) continue;
    const pl = Number(raw.profit_loss?.[i]);
    const plPct = Number(raw.profit_loss_pct?.[i]);
    days.push({
      date: nyDate(Number(timestamps[i]) * 1000),
      equity,
      profitLoss: Number.isFinite(pl) ? pl : null,
      profitLossPct: Number.isFinite(plPct) ? plPct * 100 : null,
    });
  }
  // One row per date (the last value wins if Alpaca returns an intraday point for today).
  const byDate = new Map(days.map((d) => [d.date, d]));
  return { baseValue: Number(raw?.base_value) || null, days: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

async function dailyHistory(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const raw = await broker.getPortfolioHistory({ period: "3M", timeframe: "1D" });
  const value = shapeHistory(raw);
  cache = { at: now, value };
  return value;
}

function clearCache() {
  cache = null;
}

module.exports = { shapeHistory, dailyHistory, clearCache };

// Realized-trade report for the Alpaca paper account, rebuilt from Alpaca's own filled orders (the source of
// truth for fill prices) and joined with what this engine logged at entry/exit time (strategy, score, the price
// the signal planned, why it exited). Read-only: nothing here places or changes orders, and the trading path
// does not depend on it.
const broker = require("./broker");
const entry = require("./entry");
const exitManager = require("./exit");

const WINDOW_DAYS = 14;
const CACHE_MS = 30000;
const MATCH_WINDOW_MS = 10 * 60000;
let cache = null;

// FIFO pairing of filled buys with the sells that closed them (this arm is long-only).
function pairTrades(orders) {
  const filled = (orders || [])
    .filter((o) => Number(o.filled_qty) > 0 && o.filled_at && Number(o.filled_avg_price) > 0)
    .sort((a, b) => Date.parse(a.filled_at) - Date.parse(b.filled_at));
  const lots = new Map();
  const trades = [];
  for (const order of filled) {
    const symbol = order.symbol;
    const qty = Number(order.filled_qty);
    const price = Number(order.filled_avg_price);
    if (order.side === "buy") {
      if (!lots.has(symbol)) lots.set(symbol, []);
      lots.get(symbol).push({ qty, price, at: order.filled_at, orderId: order.id });
    } else if (order.side === "sell") {
      let remaining = qty;
      const queue = lots.get(symbol) || [];
      while (remaining > 1e-9 && queue.length) {
        const lot = queue[0];
        const take = Math.min(lot.qty, remaining);
        const pnl = (price - lot.price) * take;
        trades.push({
          symbol,
          qty: take,
          entryPrice: lot.price,
          exitPrice: price,
          entryAt: lot.at,
          exitAt: order.filled_at,
          entryOrderId: lot.orderId,
          exitOrderId: order.id,
          pnl,
          pnlPct: ((price - lot.price) / lot.price) * 100,
          amount: lot.price * take,
        });
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) queue.shift();
      }
    }
  }
  return trades;
}

const nearest = (rows, symbol, at) =>
  rows
    .filter((row) => row.symbol === symbol && Math.abs(at - Date.parse(row.at)) <= MATCH_WINDOW_MS)
    .sort((a, b) => Math.abs(at - Date.parse(a.at)) - Math.abs(at - Date.parse(b.at)))[0];

// Attach strategy / planned price / exit reason from the engine's own logs. Matching is by order id when known,
// otherwise by symbol and time proximity (entries made before the metadata record existed).
function enrich(trades, { meta = [], entered = [], exits = [] } = {}) {
  return trades.map((trade) => {
    const decision = meta.find((m) => m.orderId && m.orderId === trade.entryOrderId) || nearest(entered, trade.symbol, Date.parse(trade.entryAt));
    const exit = nearest(exits, trade.symbol, Date.parse(trade.exitAt));
    const strategies = decision?.strategies || [];
    const planned = Number(decision?.plannedPrice ?? decision?.price);
    const hasPlanned = Number.isFinite(planned) && planned > 0;
    return {
      ...trade,
      strategy: decision?.lead || strategies[0] || null,
      strategies,
      score: decision?.score ?? null,
      plannedPrice: hasPlanned ? planned : null,
      slippagePct: hasPlanned ? ((trade.entryPrice - planned) / planned) * 100 : null,
      exitReason: exit?.reason || null,
    };
  });
}

function summarize(list) {
  const wins = list.filter((t) => t.pnl > 0);
  const losses = list.filter((t) => t.pnl < 0);
  const sum = (rows) => rows.reduce((total, row) => total + (Number(row.pnl) || 0), 0);
  const slips = list.map((t) => t.slippagePct).filter((v) => Number.isFinite(v));
  return {
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: list.length ? (wins.length / list.length) * 100 : null,
    totalPnl: sum(list),
    avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null,
    avgSlippagePct: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null,
  };
}

function buildStats(trades) {
  const groups = {};
  for (const trade of trades) (groups[trade.strategy || "unknown"] ||= []).push(trade);
  return {
    overall: summarize(trades),
    byStrategy: Object.entries(groups)
      .map(([strategy, list]) => ({ strategy, ...summarize(list) }))
      .sort((a, b) => b.totalPnl - a.totalPnl),
  };
}

async function summary(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const since = now - WINDOW_DAYS * 86400000;
  const orders = await broker.getOrders({ status: "closed", limit: 500, after: new Date(since).toISOString(), direction: "asc" });
  const trades = enrich(pairTrades(orders), { meta: entry.tradeMeta(), entered: entry.enteredSince(since), exits: exitManager.recentLog(500) }).sort(
    (a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt),
  );
  const value = { windowDays: WINDOW_DAYS, trades, stats: buildStats(trades) };
  cache = { at: now, value };
  return value;
}

function clearCache() {
  cache = null;
}

module.exports = { pairTrades, enrich, buildStats, summary, clearCache };

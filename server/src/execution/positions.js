const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");
const pnlHistory = require("./pnlHistory");

// Read-only snapshot of the demo account as reported by the MT4 EA. It never creates or
// changes orders; the dashboard only displays it.
const KEY = "execution-positions";
const FRESH_MS = 90_000;
const MAX_POSITIONS = 200;
const MAX_DEALS = 300;

function num(value, field, { optional = false } = {}) {
  if (value == null && optional) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const error = new Error(`שדה לא תקין: ${field}`);
    error.status = 400;
    throw error;
  }
  return n;
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function normalize(input = {}, now = Date.now()) {
  if (typeof input.accountId !== "string" || !input.accountId.trim()) {
    const error = new Error("חשבון MT4 חסר");
    error.status = 400;
    throw error;
  }
  const rows = Array.isArray(input.positions) ? input.positions.slice(0, MAX_POSITIONS) : [];
  // Closed deals with their close time in UTC epoch seconds. The EA converts broker server time to UTC;
  // the server alone decides which US trading day (New York date) a deal belongs to.
  const deals = Array.isArray(input.closedDeals)
    ? input.closedDeals
        .slice(0, MAX_DEALS)
        .map((d) => {
          const row = { t: Number(d?.t), p: Number(d?.p) };
          // Optional detail from newer EA versions; older EAs send only t and p.
          if (d?.ticket != null) row.ticket = text(String(d.ticket), 24);
          if (d?.symbol) row.symbol = text(d.symbol, 32);
          if (d?.side) row.side = d.side === "sell" ? "sell" : "buy";
          for (const k of ["lots", "openPrice", "closePrice", "openT"]) if (Number.isFinite(Number(d?.[k])) && d[k] !== null) row[k] = Number(d[k]);
          return row;
        })
        .filter((d) => Number.isFinite(d.t) && d.t > 0 && Number.isFinite(d.p))
    : null;
  return {
    accountId: input.accountId.trim().slice(0, 40),
    isDemo: input.isDemo === true,
    currency: text(input.currency, 8),
    balance: num(input.balance, "balance", { optional: true }),
    equity: num(input.equity, "equity", { optional: true }),
    profit: num(input.profit, "profit", { optional: true }),
    closedDeals: deals,
    updatedAt: new Date(now).toISOString(),
    positions: rows.map((p) => ({
      ticket: text(String(p.ticket ?? ""), 24),
      symbol: text(p.symbol, 32),
      side: p.side === "sell" ? "sell" : "buy",
      lots: num(p.lots, "lots"),
      openPrice: num(p.openPrice, "openPrice"),
      currentPrice: num(p.currentPrice, "currentPrice", { optional: true }),
      stopLoss: num(p.stopLoss, "stopLoss", { optional: true }),
      takeProfit: num(p.takeProfit, "takeProfit", { optional: true }),
      profit: num(p.profit, "profit", { optional: true }),
      minLot: num(p.minLot, "minLot", { optional: true }),
      lotStep: num(p.lotStep, "lotStep", { optional: true }),
      openedAt: text(p.openedAt, 40),
      managed: p.managed === true,
    })),
  };
}

// Account equity at the start of the New York trading day = the last equity reported before the date changed
// (so an open position carried over from yesterday starts today at zero, even if the EA was offline overnight).
// A day that begins without a previous report from an earlier date has no baseline (null) and the client
// falls back to closed-today + open.
const DAY_OPEN = "dayOpen";
function trackDayOpen(previous, snapshot, now) {
  const today = nyDate(now);
  const saved = store.get("runtime", DAY_OPEN);
  if (saved?.date === today) return;
  const prevDate = previous?.updatedAt ? nyDate(Date.parse(previous.updatedAt)) : null;
  const usable = previous && prevDate && prevDate < today && Number.isFinite(previous.equity) && previous.accountId === snapshot.accountId;
  store.put("runtime", DAY_OPEN, { date: today, equity: usable ? previous.equity : null });
}

function dayPnl(snapshot, now) {
  const base = store.get("runtime", DAY_OPEN);
  if (!base || base.date !== nyDate(now) || !Number.isFinite(base.equity) || !Number.isFinite(snapshot.equity)) return null;
  return Math.round((snapshot.equity - base.equity) * 100) / 100;
}

function save(input, now = Date.now()) {
  const snapshot = normalize(input, now);
  trackDayOpen(store.get("runtime", KEY), snapshot, now);
  store.put("runtime", KEY, snapshot);
  pnlHistory.record(snapshot.closedDeals, now);
  try { require("./outcomes").record(snapshot.closedDeals, now); } catch (e) { console.warn(`[execution] outcomes: ${e.message}`); }
  return snapshot;
}

// Realized result of deals closed on the current New York trading date. null = the EA could not
// establish the broker clock offset (or is an old version), so nothing is claimed.
function closedToday(deals, now) {
  if (!Array.isArray(deals)) return null;
  const today = nyDate(now);
  return deals.filter((d) => nyDate(d.t * 1000) === today).reduce((sum, d) => sum + d.p, 0);
}

function current(now = Date.now()) {
  const snapshot = store.get("runtime", KEY) || null;
  if (!snapshot) return { available: false, fresh: false, positions: [] };
  const fresh = Date.parse(snapshot.updatedAt || 0) >= now - FRESH_MS;
  const { closedDeals, closedToday: _legacy, ...rest } = snapshot;
  return { available: true, fresh, ...rest, closedToday: closedToday(closedDeals, now), dayPnl: dayPnl(snapshot, now), closedTodayDate: nyDate(now) };
}

module.exports = { FRESH_MS, normalize, save, current };

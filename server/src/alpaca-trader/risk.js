const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");
const broker = require("./broker");

const KIND = "alpacaTrader";
const DAY_KEY = "dayState";

function dayState(now = Date.now()) {
  const saved = store.get(KIND, DAY_KEY);
  const date = nyDate(now);
  return saved && saved.date === date ? saved : { date, baseEquity: null, baseAt: null, breachedAt: null, breach: null };
}

function putDayState(state) {
  store.put(KIND, DAY_KEY, state);
  return state;
}

// First call of a New York trading day fixes the base; later calls the same day keep it, so a loss
// already taken is never erased by restarting.
async function ensureDayBase(now = Date.now()) {
  const state = dayState(now);
  if (Number.isFinite(state.baseEquity)) return state;
  const account = await broker.getAccount();
  const equity = Number(account.equity);
  if (!Number.isFinite(equity) || equity <= 0) {
    const error = new Error("לא התקבל שווי חשבון תקין מ-Alpaca");
    error.code = "day_base_unavailable";
    throw error;
  }
  return putDayState({ ...state, baseEquity: equity, baseAt: new Date(now).toISOString() });
}

// Loss = base equity minus current equity (realized and unrealized together). Once the daily limit is
// crossed the day stays stopped even if equity later recovers.
async function evaluateDay(now = Date.now(), dailyLossPct) {
  let state = dayState(now);
  const account = await broker.getAccount().catch(() => null);
  const equity = account ? Number(account.equity) : null;
  const fresh = Number.isFinite(equity);
  const hasBase = Number.isFinite(state.baseEquity);
  const limit = hasBase && Number.isFinite(dailyLossPct) ? (state.baseEquity * dailyLossPct) / 100 : null;
  const loss = hasBase && fresh ? Math.max(0, state.baseEquity - equity) : null;
  if (hasBase && fresh && limit != null && loss >= limit && !state.breachedAt) {
    state = putDayState({ ...state, breachedAt: new Date(now).toISOString(), breach: { loss, limit } });
  }
  return { date: state.date, hasBase, baseEquity: state.baseEquity, fresh, equity: fresh ? equity : null, loss, limit, breached: Boolean(state.breachedAt), breachedAt: state.breachedAt };
}

// Market value of open positions plus pending orders, in dollars - for the exposure cap.
async function exposureNow() {
  const [positions, orders] = await Promise.all([
    broker.getPositions().catch(() => []),
    broker.getOrders({ status: "open" }).catch(() => []),
  ]);
  let total = 0;
  for (const p of positions || []) total += Math.abs(Number(p.market_value) || 0);
  for (const o of orders || []) {
    if (o.side !== "buy") continue;
    const qty = Number(o.qty) || 0;
    const price = Number(o.limit_price) || Number(o.filled_avg_price) || 0;
    total += qty * price;
  }
  return total;
}

// Blocks a new entry: day-loss breach, insufficient fresh equity, or a pending/open position already in this symbol.
async function validateSignal({ symbol, equity, now = Date.now(), profile }) {
  const day = await evaluateDay(now, profile.dailyLossPct);
  if (day.breached) {
    const error = new Error(`הפסד יומי חרג מהמגבלה (${day.loss?.toFixed(2)}$ מתוך ${day.limit?.toFixed(2)}$)`);
    error.code = "daily_loss_breached";
    throw error;
  }
  if (!Number.isFinite(equity) || equity <= 0) {
    const error = new Error("אין שווי חשבון תקין מ-Alpaca");
    error.code = "account_unavailable";
    throw error;
  }
  const [positions, orders] = await Promise.all([
    broker.getPositions().catch(() => []),
    broker.getOrders({ status: "open" }).catch(() => []),
  ]);
  if ((positions || []).some((p) => p.symbol === symbol) || (orders || []).some((o) => o.symbol === symbol)) {
    const error = new Error(`כבר יש פוזיציה או הזמנה פתוחה ב-${symbol}`);
    error.code = "symbol_busy";
    throw error;
  }
}

module.exports = { dayState, ensureDayBase, evaluateDay, exposureNow, validateSignal };

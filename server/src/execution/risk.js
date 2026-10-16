const store = require("../autopilot/store");
const settings = require("../autopilot/settings");
const { nyDate } = require("../autopilot/market");

function reject(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  throw error;
}

function validateSignal({ userId, signal, brokerAccountId, symbol, now = Date.now() }) {
  if (!brokerAccountId) reject("חשבון ברוקר לא הוגדר", "broker_account_missing");
  if (!symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) reject("סימול MT4 לא תקין", "invalid_symbol");
  if (!signal?.brokerSymbol) reject("אין מיפוי מאומת בין הסימול לאינסטרומנט של MT4", "broker_symbol_unmapped");
  if (signal.status !== "active" || Date.parse(signal.expiresAt || 0) <= now) reject("האיתות אינו בתוקף", "signal_expired");
  if (!Number.isFinite(signal.stop) || signal.stop <= 0) reject("Stop Loss חובה לפני ביצוע", "stop_loss_required");
  if (signal.side === "buy" && (!(signal.entry > signal.stop) || (signal.target != null && !(signal.target > signal.entry)))) reject("Stop Loss או יעד אינם מתאימים לכיוון הקנייה", "invalid_protection_levels");
  if (signal.side === "sell" && (!(signal.stop > signal.entry) || (signal.target != null && !(signal.target < signal.entry)))) reject("Stop Loss או יעד אינם מתאימים לכיוון המכירה", "invalid_protection_levels");
  const quantity = Number(signal.sizing?.shares ?? signal.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) reject("כמות לא תקינה", "invalid_quantity");
  const config = settings.read(userId);
  const orders = store.listUser(userId, "executionOrder");
  const activeOrders = orders.filter((order) => ["pending", "claimed", "submitted", "partially_filled", "unknown"].includes(order.status));
  if (activeOrders.length >= config.maxPositions) reject("הגעת למספר הפוזיציות המרבי", "max_positions");
  const openTrades = store.listUser(userId, "trade").filter((trade) => trade.source === "personal" && trade.status === "open");
  if (openTrades.length + activeOrders.length >= config.maxPositions) reject("הגעת למספר הפוזיציות המרבי", "max_positions");
  const today = nyDate(now);
  const dailyLoss = store.listUser(userId, "trade")
    .filter((trade) => trade.status === "closed" && trade.closedAt && nyDate(Date.parse(trade.closedAt)) === today)
    .reduce((sum, trade) => sum + Math.min(0, Number(trade.pnl) || 0), 0);
  const lossLimit = -(Number(config.equity) * Number(config.dailyLossPct) / 100);
  if (dailyLoss <= lossLimit) reject("מגבלת ההפסד היומי הופעלה", "daily_loss_limit");
  if (quantity > 100000000) reject("כמות חורגת מהמגבלה", "invalid_quantity");
  return { quantity, risk: { dailyLoss, lossLimit, maxPositions: config.maxPositions } };
}

module.exports = { validateSignal };

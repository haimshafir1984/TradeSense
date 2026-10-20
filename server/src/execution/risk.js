const store = require("../autopilot/store");
const positions = require("./positions");
const riskProfile = require("./riskProfile");

function reject(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  throw error;
}

const RECENT_FILL_MS = 3 * 60000;
const ACTIVE_ORDER = ["pending", "claimed", "submitted", "partially_filled", "unknown"];

// Applies the user's fixed Stop Loss percentage (when configured) to a signal before it becomes an order.
// Long: stop below entry; short: above it. Without a configured percentage the signal's own stop is kept.
function applyStopPolicy(signal, profile = riskProfile.read()) {
  const pct = profile.stopLossPct;
  if (!Number.isFinite(pct)) return signal;
  const entry = Number(signal.maxEntry || signal.entry);
  if (!Number.isFinite(entry) || entry <= 0) return signal;
  const stop = signal.side === "sell" ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
  return { ...signal, stop: Math.round(stop * 1e6) / 1e6, stopPolicy: "fixed_pct" };
}

// Server-side gate for every new entry. It fails closed: no fresh demo data from MT4 means no entry.
function validateSignal({ userId, signal, brokerAccountId, symbol, now = Date.now() }) {
  if (!brokerAccountId) reject("חשבון ברוקר לא הוגדר", "broker_account_missing");
  if (!symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) reject("סימול MT4 לא תקין", "invalid_symbol");
  if (!signal?.brokerSymbol) reject("אין מיפוי מאומת בין הסימול לאינסטרומנט של MT4", "broker_symbol_unmapped");
  if (signal.status !== "active" || Date.parse(signal.expiresAt || 0) <= now) reject("האיתות אינו בתוקף", "signal_expired");
  if (!Number.isFinite(signal.stop) || signal.stop <= 0) reject("Stop Loss חובה לפני ביצוע", "stop_loss_required");
  if (signal.side === "sell") reject("מכירה בחסר מושבתת עד לאימות תמיכה במנוע האיתותים, ב־Colmex וב־MT4", "short_disabled");
  if (signal.side === "buy" && (!(signal.entry > signal.stop) || (signal.target != null && !(signal.target > signal.entry)))) reject("Stop Loss או יעד אינם מתאימים לכיוון הקנייה", "invalid_protection_levels");
  const quantity = Number(signal.sizing?.shares ?? signal.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) reject("כמות לא תקינה", "invalid_quantity");
  if (quantity > 100000000) reject("כמות חורגת מהמגבלה", "invalid_quantity");

  const profile = riskProfile.read();
  const snapshot = positions.current(now);
  if (!snapshot.fresh || snapshot.isDemo !== true) reject("אין דיווח עדכני מחשבון הדמו ב־MT4; כניסות חדשות נחסמות עד לבירור המצב", "mt4_unknown");

  // Daily loss: measured against the equity captured at the first activation of the US trading day.
  const day = riskProfile.evaluateDay(now, profile);
  if (!day.hasBase) reject("בסיס ההפסד היומי טרם נקבע; הפעלת המסחר קובעת אותו", "day_base_missing");
  if (day.breached || (day.limit != null && day.loss != null && day.loss >= day.limit)) reject("מגבלת ההפסד היומי הופעלה; אין כניסות חדשות עד יום המסחר הבא", "daily_loss_limit");

  // One symbol, one position: no second entry while MT4 holds the symbol or an order for it is still active.
  // MT4 reports Colmex symbols with a "#" suffix; the server uses the plain ticker.
  const plain = (v) => String(v || "").replace(/#$/, "").toLowerCase();
  const same = (a) => plain(a) === plain(symbol);
  if (snapshot.positions.some((p) => same(p.symbol))) reject("כבר יש פוזיציה פתוחה במניה הזו", "symbol_busy");
  // Orders live in one shared collection and every user of this server trades the same MT4 account, so the
  // check covers all users' orders on this account. A just-filled order may not appear in the MT4 report yet.
  const accountOrders = store.list("executionOrder").filter((order) => !brokerAccountId || order.brokerAccountId === brokerAccountId);
  const justFilled = (order) => order.status === "filled" && now - Date.parse(order.completedAt || 0) < RECENT_FILL_MS;
  if (accountOrders.some((order) => (ACTIVE_ORDER.includes(order.status) || justFilled(order)) && same(order.symbol))) reject("כבר יש פקודה פעילה במניה הזו", "symbol_busy");

  // Concurrency: only positions TradeSense manages count, plus orders that are not yet confirmed.
  if (profile.maxConcurrent != null) {
    const activeOrders = accountOrders.filter((order) => ACTIVE_ORDER.includes(order.status));
    const open = snapshot.positions.filter((p) => p.managed);
    if (open.length + activeOrders.length >= profile.maxConcurrent) reject("הגעת למספר העסקאות המרבי במקביל", "max_positions");
  }
  return { quantity, risk: { dayLoss: day.loss, limit: day.limit, maxConcurrent: profile.maxConcurrent, source: "mt4" } };
}

module.exports = { applyStopPolicy, validateSignal };

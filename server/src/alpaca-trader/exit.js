const store = require("../autopilot/store");
const { nyDate, nyTimestamp } = require("../autopilot/market");
const broker = require("./broker");
const settings = require("./settings");

const KIND = "alpacaTrader";
const K_PLAN = `${KIND}:exitPlan`; // symbol -> { stop, target, enteredAt }
const K_LOG = `${KIND}:exitLog`;

// Recorded right after an entry order is placed, so the exit manager knows what to defend.
function recordPlan(symbol, { stop, target }, now = Date.now()) {
  store.put(K_PLAN, symbol, { symbol, stop: Number(stop) || null, initialStop: Number(stop) || null, target: Number(target) || null, enteredAt: new Date(now).toISOString() });
}

// Break-even trailing stop. Once the price has gained breakEvenAtR times the initial risk (entry - initial stop), the stop
// moves up to the entry price, so a trade that was clearly working cannot turn into a loss. Only ever raises the stop.
// Returns the (possibly updated) plan; changes nothing when disabled or when the data needed is missing.
function armBreakEven(plan, { entryPrice, price, profile, now }) {
  if (!plan || !profile?.trailingStopEnabled || plan.breakEvenAt) return plan;
  if (![entryPrice, price, plan.stop].every(Number.isFinite)) return plan;
  const initialStop = Number.isFinite(plan.initialStop) ? plan.initialStop : plan.stop;
  const risk = entryPrice - initialStop;
  const triggerR = Number(profile.breakEvenAtR) > 0 ? Number(profile.breakEvenAtR) : 1;
  if (!(risk > 0) || price < entryPrice + triggerR * risk) return plan;
  const next = { ...plan, initialStop, stop: Math.max(plan.stop, entryPrice), breakEvenAt: new Date(now).toISOString() };
  store.put(K_PLAN, plan.symbol, next);
  return next;
}

function logExit(entry, now = Date.now()) {
  const id = `${new Date(now).toISOString()}:${entry.symbol}`;
  store.put(K_LOG, id, { id, at: new Date(now).toISOString(), ...entry });
  return id;
}

function isPastClose(now) {
  return now >= nyTimestamp(nyDate(now), "15:55");
}

// One pass over every open Alpaca position: close it if the stop, the target, the daily-loss breach,
// or the end of day calls for it. Never throws; a single symbol's failure is logged and skipped.
async function manage({ dailyBreached, now = Date.now(), profile } = {}) {
  const trailProfile = profile || settings.read();
  const results = [];
  let positions;
  try {
    positions = await broker.getPositions();
  } catch (error) {
    return [{ outcome: "error", reason: error.message }];
  }
  const eod = isPastClose(now);
  for (const position of positions || []) {
    const symbol = position.symbol;
    const qty = Math.abs(Number(position.qty) || 0);
    if (qty <= 0) continue;
    const price = Number(position.current_price);
    let plan = store.get(K_PLAN, symbol);
    try {
      plan = armBreakEven(plan, { entryPrice: Number(position.avg_entry_price), price, profile: trailProfile, now });
    } catch {
      // the trailing stop is best-effort; the original stop/target below still apply
    }
    let reason = null;
    if (dailyBreached) reason = "daily_loss_breached";
    else if (eod) reason = "end_of_day";
    else if (plan && Number.isFinite(price)) {
      if (Number.isFinite(plan.stop) && price <= plan.stop) reason = plan.breakEvenAt ? "breakeven_stop" : "stop";
      else if (Number.isFinite(plan.target) && price >= plan.target) reason = "target";
    }
    if (!reason) continue;
    try {
      await broker.closePosition(symbol);
      store.remove(K_PLAN, symbol);
      logExit({ symbol, reason, qty, price: price || null }, now);
      results.push({ symbol, outcome: "closed", reason });
    } catch (error) {
      logExit({ symbol, reason: `${reason}_failed`, error: error.message }, now);
      results.push({ symbol, outcome: "error", reason: error.message });
    }
  }
  return results;
}

function recentLog(limit = 100) {
  return store.list(K_LOG).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}

function plans() {
  return store.list(K_PLAN);
}

module.exports = { recordPlan, manage, recentLog, isPastClose, armBreakEven, plans };

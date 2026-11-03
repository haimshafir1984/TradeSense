const store = require("../autopilot/store");
const { nyDate, nyTimestamp } = require("../autopilot/market");
const broker = require("./broker");

const KIND = "alpacaTrader";
const K_PLAN = `${KIND}:exitPlan`; // symbol -> { stop, target, enteredAt }
const K_LOG = `${KIND}:exitLog`;

// Recorded right after an entry order is placed, so the exit manager knows what to defend.
function recordPlan(symbol, { stop, target }, now = Date.now()) {
  store.put(K_PLAN, symbol, { symbol, stop: Number(stop) || null, target: Number(target) || null, enteredAt: new Date(now).toISOString() });
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
async function manage({ dailyBreached, now = Date.now() } = {}) {
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
    const plan = store.get(K_PLAN, symbol);
    let reason = null;
    if (dailyBreached) reason = "daily_loss_breached";
    else if (eod) reason = "end_of_day";
    else if (plan && Number.isFinite(price)) {
      if (Number.isFinite(plan.stop) && price <= plan.stop) reason = "stop";
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

module.exports = { recordPlan, manage, recentLog, isPastClose };

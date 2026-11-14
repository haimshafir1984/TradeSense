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

// After the partial exit the rest of the position has no fixed target. Its stop only ever moves up: it follows the highest
// price seen at plan.trailDistance below it (and never below the profit locked when the partial was taken).
function trailRemainder(plan, { price }) {
  if (!plan?.partialAt || !Number.isFinite(price)) return plan;
  const distance = Number(plan.trailDistance);
  if (!(distance > 0)) return plan;
  const highWater = Math.max(Number(plan.highWater) || price, price);
  const stop = Math.max(Number(plan.stop) || 0, highWater - distance);
  if (stop === plan.stop && highWater === plan.highWater) return plan;
  const next = { ...plan, highWater, stop };
  store.put(K_PLAN, plan.symbol, next);
  return next;
}

// Sells part of the position at the target and arms the trailing stop for the rest. Returns the result row, or null when
// the position is too small to split (the caller then closes it fully, the old behaviour).
async function takePartial(position, plan, { qty, price, profile, now }) {
  const symbol = position.symbol;
  const sellQty = Math.floor((qty * profile.partialPct) / 100);
  const entry = Number(position.avg_entry_price);
  const initialStop = Number.isFinite(plan.initialStop) ? plan.initialStop : plan.stop;
  const risk = entry - initialStop;
  if (!(sellQty >= 1) || qty - sellQty < 1 || !(risk > 0) || !Number.isFinite(price)) return null;
  await broker.placeMarketOrder({ symbol, qty: sellQty, side: "sell" });
  const trailDistance = profile.partialTrailR * risk;
  const stop = Math.min(Math.max(plan.stop, entry + profile.partialLockR * risk, price - trailDistance), price - 0.01);
  store.put(K_PLAN, symbol, { ...plan, initialStop, target: null, partialAt: new Date(now).toISOString(), partialQty: sellQty, trailDistance, highWater: price, stop });
  logExit({ symbol, reason: "partial_target", qty: sellQty, price }, now);
  require("./notify").exited({ symbol, reason: "partial_target", qty: sellQty, price, entryPrice: entry, pnl: (Number(position.unrealized_pl) * sellQty) / qty, now });
  return { symbol, outcome: "partial", reason: "partial_target", qty: sellQty };
}

function logExit(entry, now = Date.now()) {
  const id = `${new Date(now).toISOString()}:${entry.symbol}`;
  store.put(K_LOG, id, { id, at: new Date(now).toISOString(), ...entry });
  return id;
}

// Regular session only, with the day's real hours from Alpaca's calendar (session.js): a shortened day closes at 13:00, a
// holiday has no session. Outside it a market order is not executed: it queues for the next open. On 2026-11-09 the
// end-of-day close went out at 16:20 NY, sat in the queue overnight, and filled at the next open after a -8..-10% gap.
const session = require("./session");
const inSession = (now) => session.inSession(now);
// Five minutes before the real close (15:55 on a regular day, 12:55 on a shortened one).
const isPastClose = (now) => session.isPastClose(now);

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
  const sessionOpen = inSession(now);
  const today = nyDate(now);
  for (const position of positions || []) {
    if (!sessionOpen) continue; // never submit an order that would only queue for the next open
    const symbol = position.symbol;
    const qty = Math.abs(Number(position.qty) || 0);
    if (qty <= 0) continue;
    const price = Number(position.current_price);
    let plan = store.get(K_PLAN, symbol);
    try {
      plan = armBreakEven(plan, { entryPrice: Number(position.avg_entry_price), price, profile: trailProfile, now });
      plan = trailRemainder(plan, { price });
    } catch {
      // the trailing stop is best-effort; the original stop/target below still apply
    }
    let reason = null;
    if (dailyBreached) reason = "daily_loss_breached";
    else if (plan?.enteredAt && nyDate(Date.parse(plan.enteredAt)) < today) reason = "carried_over"; // held past an earlier close: out at the first chance
    else if (eod) reason = "end_of_day";
    else if (plan && Number.isFinite(price)) {
      if (Number.isFinite(plan.stop) && price <= plan.stop) reason = plan.partialAt ? "trailing_stop" : plan.breakEvenAt ? "breakeven_stop" : "stop";
      else if (Number.isFinite(plan.target) && price >= plan.target) reason = "target";
    }
    if (!reason) continue;
    if (reason === "target" && trailProfile.partialEnabled && !plan.partialAt) {
      try {
        const partial = await takePartial(position, plan, { qty, price, profile: trailProfile, now });
        if (partial) {
          results.push(partial);
          continue;
        }
      } catch (error) {
        logExit({ symbol, reason: "partial_target_failed", error: error.message }, now);
        results.push({ symbol, outcome: "error", reason: error.message });
        continue;
      }
    }
    try {
      await broker.closePosition(symbol);
      store.remove(K_PLAN, symbol);
      logExit({ symbol, reason, qty, price: price || null }, now);
      require("./notify").exited({ symbol, reason, qty, price, entryPrice: Number(position.avg_entry_price), pnl: Number(position.unrealized_pl), now });
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

module.exports = { recordPlan, manage, recentLog, isPastClose, inSession, armBreakEven, trailRemainder, plans };

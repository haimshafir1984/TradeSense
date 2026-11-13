const store = require("../autopilot/store");
const settings = require("./settings");
const broker = require("./broker");
const risk = require("./risk");
const scan = require("./scan");
const entry = require("./entry");
const exitManager = require("./exit");

const KIND = "alpacaTrader";
const STATE_KEY = "state";
const TICK_MS = Number(process.env.ALPACA_TRADER_SCAN_INTERVAL_MS || 300000); // 5 min, matches the intraday strategies' own bar size
// Delay the first tick after a (re)deploy so this engine's startup universe-build burst does not land
// on top of the main autopilot engine's own startup burst - that collision caused a production OOM
// crash loop (exit 137) on 2026-11-03.
const STARTUP_DELAY_MS = Number(process.env.ALPACA_TRADER_STARTUP_DELAY_MS || 180000);

// The strategies only accept a just-closed 5-minute candle (strategies.js: the newest closed candle must be at most
// 7 minutes old). A scan that runs late inside a 5-minute window sees a candle 9+ minutes old and rejects every
// stock as intraday_missing; with a fixed interval that phase never changes (2026-11-06: 134/134 intraday_missing).
// So scans are aligned to run shortly after each 5-minute boundary, once the new candle has been published.
const BAR_MS = 300000;
const ALIGN_DELAY_MS = Number(process.env.ALPACA_TRADER_ALIGN_DELAY_MS || 20000);
function msUntilNextBar(now = Date.now(), delayMs = ALIGN_DELAY_MS) {
  const wait = BAR_MS - (now % BAR_MS) + delayMs;
  return wait > BAR_MS ? wait - BAR_MS : wait;
}

let timer = null;
let alignTimer = null;
let startupTimer = null;
let running = false;

// Status only: a locked database must not turn into an unhandled rejection that ends the process (see autopilot/engine.js).
function state(patch) {
  try {
    return store.put(KIND, STATE_KEY, { ...store.get(KIND, STATE_KEY), ...patch });
  } catch (error) {
    console.warn(`[alpaca-trader] state update skipped: ${error.message}`);
    return null;
  }
}

// Short history of each in-session scan, so "why was nothing bought today?" can be answered after the fact (the status
// only keeps the latest scan). Reason codes are summed over all stocks and strategies.
const K_SCANLOG = `${KIND}:scanLog`;
const MAX_SCANLOG = 300;

function recordScan(now, diagnostics, entries) {
  try {
    if (!diagnostics?.marketOpen) return;
    const reasons = {};
    for (const perStrategy of Object.values(diagnostics.reasons || {})) for (const [code, count] of Object.entries(perStrategy)) reasons[code] = (reasons[code] || 0) + count;
    const at = new Date(now).toISOString();
    store.put(K_SCANLOG, at, {
      id: at, at, universeSize: diagnostics.universeSize, evaluated: diagnostics.evaluated, matched: diagnostics.matched,
      rvolOver1_2: diagnostics.rvolOver1_2, rvolMax: diagnostics.rvolMax, reasons, entered: (entries || []).filter((e) => e.outcome === "entered").length,
      errors: (diagnostics.errors || []).length,
    });
    const ids = store.listIds(K_SCANLOG).sort();
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SCANLOG))) store.remove(K_SCANLOG, old);
  } catch {
    // diagnostics only
  }
}

function recentScans(limit = 40) {
  return store.list(K_SCANLOG).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}

function getState() {
  return store.get(KIND, STATE_KEY) || { startedAt: null, heartbeatAt: null };
}

const roundPrice = (value) => (value >= 1 ? Math.round(value * 100) / 100 : Math.round(value * 10000) / 10000);

// An IOC order is final within moments; poll briefly for its outcome. Resolves to the shares actually bought and the average price.
async function confirmFill(order) {
  let current = order;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (current && ["filled", "canceled", "expired", "rejected", "done_for_day"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 500));
    current = await broker.getOrder(order.id).catch(() => current);
  }
  return { qty: Number(current?.filled_qty) || 0, price: Number(current?.filled_avg_price) || null, status: current?.status || null };
}

async function placeOrder(symbol, shares, signal, profile = settings.read()) {
  const planned = Number(signal.entry);
  if (profile.limitEntryEnabled && planned > 0) {
    const limitPrice = roundPrice(planned * (1 + Number(profile.maxSlippagePct) / 100));
    const order = await broker.placeLimitOrder({ symbol, qty: shares, side: "buy", limitPrice, timeInForce: "ioc" });
    const fill = await confirmFill(order);
    if (!(fill.qty > 0)) {
      const error = new Error(`המחיר כבר מעל התקרה (${limitPrice}); לא נקנה`);
      error.code = "price_too_far";
      throw error;
    }
    exitManager.recordPlan(symbol, { stop: signal.stop, target: signal.target });
    return { orderId: order?.id || null, filledQty: fill.qty, fillPrice: fill.price };
  }
  const order = await broker.placeMarketOrder({ symbol, qty: shares, side: "buy" });
  exitManager.recordPlan(symbol, { stop: signal.stop, target: signal.target });
  return { orderId: order?.id || null };
}

// Exits run in their own loop so that a slow scan (universe build, many symbols, a stalled request) can never delay a
// stop or the end-of-day close. A lock keeps the scan tick and this loop from closing the same position twice.
const EXIT_TICK_MS = Number(process.env.ALPACA_TRADER_EXIT_INTERVAL_MS || 30000);
let exitRunning = false;
let exitTimer = null;

async function guardedManage({ dailyBreached, now, profile }) {
  if (exitRunning) return [];
  exitRunning = true;
  try {
    return await exitManager.manage({ dailyBreached, now, profile });
  } finally {
    exitRunning = false;
  }
}

let lastExitTickAt = null; // in memory only: the exit loop runs every 30s, not worth a database write each time

async function exitTick(now = Date.now()) {
  try {
    if (!broker.isConfigured() || !exitManager.inSession(now)) return [];
    lastExitTickAt = new Date(now).toISOString();
    const profile = settings.read();
    const day = await risk.evaluateDay(now, profile.dailyLossPct).catch(() => null);
    const results = await guardedManage({ dailyBreached: day?.breached === true, now, profile });
    if (results.length) state({ exits: results, exitCheckedAt: new Date(now).toISOString() });
    return results;
  } catch (error) {
    console.warn(`[alpaca-trader] exit check failed: ${error.message}`);
    return [];
  }
}

async function tick(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const profile = settings.read();
    state({ heartbeatAt: new Date(now).toISOString(), enabled: profile.enabled });
    if (!broker.isConfigured()) {
      state({ error: "מפתחות Alpaca Trader לא מוגדרים" });
      return;
    }
    const day = await risk.evaluateDay(now, profile.dailyLossPct).catch((error) => ({ error: error.message }));
    const exits = await guardedManage({ dailyBreached: day?.breached === true, now, profile }).catch((error) => [{ outcome: "error", reason: error.message }]);

    const diagnostics = await scan.run(profile, now).catch((error) => ({ error: error.message }));

    let entries = [];
    if (profile.enabled && diagnostics.marketOpen) {
      try {
        await risk.ensureDayBase(now);
        const account = await broker.getAccount();
        const equity = Number(account.equity);
        const { exposure, count: openCount } = await risk.exposureSnapshot();
        entries = await entry.flush({
          profile,
          equity,
          exposure,
          openCount,
          enabled: profile.enabled,
          now,
          place: async (symbol, shares, signal) => {
            await risk.validateSignal({ symbol, equity, now, profile });
            return placeOrder(symbol, shares, signal, profile);
          },
        });
      } catch (error) {
        state({ error: error.message });
      }
    }
    recordScan(now, diagnostics, entries);
    state({ error: null, lastScanAt: new Date(now).toISOString(), diagnostics, day, exits, entries });
  } catch (error) {
    state({ error: error.message });
  } finally {
    running = false;
  }
}

function start() {
  if (timer || startupTimer || alignTimer || process.env.ALPACA_TRADER_ENABLED !== "true") return;
  state({ startedAt: new Date().toISOString() });
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    alignTimer = setTimeout(() => {
      alignTimer = null;
      tick();
      timer = setInterval(tick, TICK_MS);
      timer.unref();
    }, msUntilNextBar());
    alignTimer.unref();
    exitTimer = setInterval(exitTick, EXIT_TICK_MS);
    exitTimer.unref();
  }, STARTUP_DELAY_MS);
  startupTimer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  if (alignTimer) clearTimeout(alignTimer);
  if (exitTimer) clearInterval(exitTimer);
  exitTimer = null;
  timer = null;
  startupTimer = null;
  alignTimer = null;
}

async function view(now = Date.now()) {
  const profile = settings.read();
  const account = broker.isConfigured() ? await broker.getAccount().catch((error) => ({ error: error.message })) : null;
  const positions = broker.isConfigured() ? await broker.getPositions().catch(() => []) : [];
  const day = await risk.evaluateDay(now, profile.dailyLossPct).catch((error) => ({ error: error.message }));
  const universe = require("./universe").status(now);
  const performance = await require("./trades").summary(now).catch((error) => ({ trades: [], stats: null, error: error.message }));
  return {
    configured: broker.isConfigured(),
    profile,
    defaults: settings.DEFAULTS,
    state: getState(),
    account,
    positions,
    day,
    universe,
    candidates: entry.todayBoxes(now),
    decisions: entry.recentLog(100),
    scans: recentScans(60),
    history: await require("./history").dailyHistory(now).catch(() => ({ baseValue: null, days: [] })),
    exitLoop: { lastTickAt: lastExitTickAt, intervalMs: EXIT_TICK_MS },
    exits: exitManager.recentLog(100),
    plans: exitManager.plans(),
    performance,
  };
}

module.exports = { start, stop, tick, exitTick, view, TICK_MS, msUntilNextBar, recordScan, recentScans, placeOrder };

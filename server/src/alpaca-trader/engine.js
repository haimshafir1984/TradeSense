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

function state(patch) {
  return store.put(KIND, STATE_KEY, { ...store.get(KIND, STATE_KEY), ...patch });
}

function getState() {
  return store.get(KIND, STATE_KEY) || { startedAt: null, heartbeatAt: null };
}

async function placeOrder(symbol, shares, signal) {
  const order = await broker.placeMarketOrder({ symbol, qty: shares, side: "buy" });
  exitManager.recordPlan(symbol, { stop: signal.stop, target: signal.target });
  return { orderId: order?.id || null };
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
    const exits = await exitManager.manage({ dailyBreached: day?.breached === true, now }).catch((error) => [{ outcome: "error", reason: error.message }]);

    const diagnostics = await scan.run(profile, now).catch((error) => ({ error: error.message }));

    let entries = [];
    if (profile.enabled && diagnostics.marketOpen) {
      try {
        await risk.ensureDayBase(now);
        const account = await broker.getAccount();
        const equity = Number(account.equity);
        const exposure = await risk.exposureNow();
        entries = await entry.flush({
          profile,
          equity,
          exposure,
          enabled: profile.enabled,
          now,
          place: async (symbol, shares, signal) => {
            await risk.validateSignal({ symbol, equity, now, profile });
            return placeOrder(symbol, shares, signal);
          },
        });
      } catch (error) {
        state({ error: error.message });
      }
    }
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
  }, STARTUP_DELAY_MS);
  startupTimer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  if (alignTimer) clearTimeout(alignTimer);
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
    exits: exitManager.recentLog(100),
  };
}

module.exports = { start, stop, tick, view, TICK_MS, msUntilNextBar };

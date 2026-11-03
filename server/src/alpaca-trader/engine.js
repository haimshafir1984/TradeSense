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

let timer = null;
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
  if (timer || process.env.ALPACA_TRADER_ENABLED !== "true") return;
  state({ startedAt: new Date().toISOString() });
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
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

module.exports = { start, stop, tick, view, TICK_MS };

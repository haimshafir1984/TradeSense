const store = require("../autopilot/store");
const positions = require("./positions");
const { nyDate } = require("../autopilot/market");

// User-defined execution rules. This record is the single source of truth for what the server
// enforces on new entries and on managed positions. It never changes the signal engine's own settings.
const PROFILE_KEY = "execution-risk-profile";
const DAY_KEY = "execution-day-state";

const DEFAULTS = Object.freeze({
  dailyLoss: { pct: 7, amountUsd: null, action: "close_all" },
  maxConcurrent: null,
  stopLossPct: null,
  takeProfit: {
    tiers: [
      { triggerPct: 3, sellPct: null },
      { triggerPct: 6, sellPct: null },
      { triggerPct: null, sellPct: null },
    ],
    stopAfter: "keep",
    manualStopPrice: null,
  },
  endOfDay: { mode: "close" },
  // Master switch for automatic management of open positions (loss-limit close, take-profit tiers, end of day).
  // Off by default: entries are still gated by the limits, but nothing is closed or modified automatically.
  autoManage: false,
  // Short selling stays disabled until the signal engine, Colmex and MT4 support are verified.
  shortEnabled: false,
});

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function optionalNumber(value, label, { min = 0, max = Infinity, exclusiveMin = true } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || (exclusiveMin ? n <= min : n < min) || n > max) fail(`ערך לא תקין: ${label}`);
  return n;
}

function validate(input = {}, base = DEFAULTS) {
  const out = clone(base);
  if (input.dailyLoss !== undefined) {
    const d = input.dailyLoss || {};
    const pct = d.pct === undefined ? out.dailyLoss.pct : optionalNumber(d.pct, "אחוז הפסד יומי", { max: 100 });
    const amountUsd = d.amountUsd === undefined ? out.dailyLoss.amountUsd : optionalNumber(d.amountUsd, "סכום הפסד יומי");
    if (pct === null && amountUsd === null) fail("חובה להגדיר אחוז הפסד יומי או סכום בדולרים");
    const action = d.action === undefined ? out.dailyLoss.action : d.action;
    if (!["close_all", "stop_new"].includes(action)) fail("פעולה לא תקינה בהגעה למגבלת ההפסד");
    out.dailyLoss = { pct, amountUsd, action };
  }
  if (input.maxConcurrent !== undefined) {
    const v = input.maxConcurrent;
    if (v === null || v === "") out.maxConcurrent = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1000) fail("מגבלת עסקאות במקביל חייבת להיות מספר שלם חיובי");
      out.maxConcurrent = n;
    }
  }
  if (input.stopLossPct !== undefined) out.stopLossPct = optionalNumber(input.stopLossPct, "אחוז Stop Loss", { max: 90 });
  if (input.takeProfit !== undefined) {
    const t = input.takeProfit || {};
    if (t.tiers !== undefined) {
      if (!Array.isArray(t.tiers) || t.tiers.length !== 3) fail("יש להגדיר שלוש מדרגות (אפשר להשאיר ריקות)");
      const tiers = t.tiers.map((tier, i) => ({
        triggerPct: optionalNumber(tier?.triggerPct, `מדרגה ${i + 1}: אחוז עלייה`, { max: 1000 }),
        sellPct: optionalNumber(tier?.sellPct, `מדרגה ${i + 1}: אחוז מכירה`, { max: 100 }),
      }));
      let previous = 0;
      let sold = 0;
      for (const [i, tier] of tiers.entries()) {
        if (tier.triggerPct !== null) {
          if (tier.triggerPct <= previous) fail(`מדרגה ${i + 1}: אחוז העלייה חייב להיות גבוה מהמדרגה הקודמת`);
          previous = tier.triggerPct;
        }
        if (tier.sellPct !== null && tier.triggerPct === null) fail(`מדרגה ${i + 1}: אחוז מכירה בלי אחוז עלייה`);
        if (tier.triggerPct !== null && tier.sellPct !== null) sold += tier.sellPct;
      }
      if (sold > 100 + 1e-9) fail("סכום אחוזי המכירה של המדרגות חורג מ־100% מהפוזיציה המקורית");
      out.takeProfit.tiers = tiers;
    }
    if (t.stopAfter !== undefined) {
      if (!["keep", "breakeven", "manual"].includes(t.stopAfter)) fail("התנהגות סטופ לא תקינה");
      out.takeProfit.stopAfter = t.stopAfter;
    }
    if (t.manualStopPrice !== undefined) out.takeProfit.manualStopPrice = optionalNumber(t.manualStopPrice, "מחיר סטופ ידני");
    if (out.takeProfit.stopAfter === "manual" && out.takeProfit.manualStopPrice === null) fail("בחרת סטופ ידני ולא הוגדר מחיר");
  }
  if (input.endOfDay !== undefined) {
    const mode = input.endOfDay?.mode;
    if (!["close", "keep"].includes(mode)) fail("הגדרת סוף יום לא תקינה");
    out.endOfDay = { mode };
  }
  if (input.autoManage !== undefined) {
    if (typeof input.autoManage !== "boolean") fail("ערך לא תקין: ניהול אוטומטי");
    out.autoManage = input.autoManage;
  }
  // Short selling cannot be switched on from here.
  out.shortEnabled = false;
  return out;
}

function read() {
  const saved = store.get("runtime", PROFILE_KEY);
  if (!saved) return clone(DEFAULTS);
  try {
    return validate(saved, clone(DEFAULTS));
  } catch {
    return clone(DEFAULTS);
  }
}

function save(input) {
  const next = validate(input, read());
  store.put("runtime", PROFILE_KEY, next);
  return next;
}

function dayState(now = Date.now()) {
  const saved = store.get("runtime", DAY_KEY);
  const date = nyDate(now);
  return saved && saved.date === date ? saved : { date, baseEquity: null, baseAt: null, breachedAt: null, breach: null };
}

function putDayState(state) {
  store.put("runtime", DAY_KEY, state);
  return state;
}

// Called when trading is activated. The first activation of a US trading day fixes the base; stopping
// and restarting later the same day keeps it, so the accumulated loss is never reset.
function ensureDayBase(now = Date.now()) {
  const state = dayState(now);
  if (Number.isFinite(state.baseEquity)) return state;
  const snapshot = positions.current(now);
  if (!snapshot.fresh || snapshot.isDemo !== true || !Number.isFinite(snapshot.equity) || snapshot.equity <= 0) {
    const error = new Error("אין דיווח עדכני של שווי החשבון מ־MT4, ולכן אי אפשר לקבוע את בסיס ההפסד היומי");
    error.status = 409;
    error.code = "day_base_unavailable";
    throw error;
  }
  return putDayState({ ...state, baseEquity: snapshot.equity, baseAt: new Date(now).toISOString() });
}

function limitUsd(profile, baseEquity) {
  const candidates = [];
  if (Number.isFinite(profile.dailyLoss.pct)) candidates.push((baseEquity * profile.dailyLoss.pct) / 100);
  if (Number.isFinite(profile.dailyLoss.amountUsd)) candidates.push(profile.dailyLoss.amountUsd);
  return candidates.length ? Math.min(...candidates) : null;
}

// Loss = base equity minus current equity: realized and unrealized together, independent of trade history.
// Once the limit is reached the day stays stopped, even if equity recovers later.
function evaluateDay(now = Date.now(), profile = read()) {
  let state = dayState(now);
  const snapshot = positions.current(now);
  const fresh = snapshot.fresh && snapshot.isDemo === true && Number.isFinite(snapshot.equity);
  const hasBase = Number.isFinite(state.baseEquity);
  const limit = hasBase ? limitUsd(profile, state.baseEquity) : null;
  const loss = hasBase && fresh ? Math.max(0, state.baseEquity - snapshot.equity) : null;
  if (hasBase && fresh && limit != null && loss >= limit && !state.breachedAt) {
    state = putDayState({
      ...state,
      breachedAt: new Date(now).toISOString(),
      breach: { loss, limit, action: profile.dailyLoss.action },
    });
  }
  return {
    date: state.date,
    hasBase,
    baseEquity: state.baseEquity,
    baseAt: state.baseAt,
    fresh,
    equity: fresh ? snapshot.equity : null,
    loss,
    limit,
    breached: Boolean(state.breachedAt),
    breachedAt: state.breachedAt,
    breach: state.breach,
  };
}

module.exports = { DEFAULTS, validate, read, save, dayState, ensureDayBase, limitUsd, evaluateDay };

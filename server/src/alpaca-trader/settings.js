const store = require("../autopilot/store");

// Editable profile for the Alpaca paper-trading arm. One global record (one account), separate from
// every setting the MT4/Colmex side reads. Changing this never touches execution/* or entryProfile/riskProfile.
const KEY = "profile";
const KIND = "alpacaTrader";

// Agreed with the user 2026-11-03: start from the live MT4 side's numbers, nudged for a more volatile
// universe (lower per-trade % so the same % risks less in dollars on a bigger-swinging stock), then
// raised again per explicit instruction (totalExposurePct 60, maxRiskPct 4). No Colmex lot minimum
// applies here (Alpaca accepts any share count, even fractional): minShares removed, floor is 1.
const DEFAULTS = Object.freeze({
  enabled: false,
  windowMin: 5,
  minScore: 45,
  immediateScore: 80,
  familyPoints: [40, 65, 80, 90],
  qualityMax: 10,
  catalystMax: 8,
  perTradeMinPct: 30,
  perTradeMaxPct: 50,
  totalExposurePct: 60,
  maxRiskPct: 4,
  minShares: 1,
  dailyLossPct: 7,
  minPrice: 3,
  minAdv20: 3_000_000,
  // Upper liquidity bound: the arm targets volatile small/mid-caps, so mega-caps above this are left out.
  maxAdv20: 150_000_000,
  // gap_pullback and momentum_bull_flag need a news/no-news reading (args.hasNews) that this v1 does
  // not yet wire up; they are left out so they don't just sit there skipping with "news_needed" every
  // cycle. The other 7 strategies don't need it.
  strategies: ["orb15", "orb15_retest", "vwap_reclaim", "vwap_pullback", "reversal5", "pullback2_v1", "breakout20_v1"],
});

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function num(value, label, { min, max }) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(`ערך לא תקין: ${label}`);
  return n;
}

function validate(input = {}, base = DEFAULTS) {
  const out = clone(base);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") fail("ערך לא תקין: מופעל");
    out.enabled = input.enabled;
  }
  if (input.windowMin !== undefined) out.windowMin = num(input.windowMin, "חלון איסוף (דקות)", { min: 1, max: 15 });
  if (input.minScore !== undefined) out.minScore = num(input.minScore, "ציון מינימלי", { min: 1, max: 99 });
  if (input.immediateScore !== undefined) out.immediateScore = num(input.immediateScore, "ציון להחלטה מיידית", { min: out.minScore, max: 100 });
  if (input.familyPoints !== undefined) {
    if (!Array.isArray(input.familyPoints) || input.familyPoints.length !== 4) fail("נדרשות בדיוק 4 נקודות משפחה");
    out.familyPoints = input.familyPoints.map((v, i) => num(v, `נקודות משפחה ${i + 1}`, { min: 0, max: 100 }));
  }
  if (input.qualityMax !== undefined) out.qualityMax = num(input.qualityMax, "תקרת איכות", { min: 0, max: 50 });
  if (input.catalystMax !== undefined) out.catalystMax = num(input.catalystMax, "תקרת קטליסט", { min: 0, max: 50 });
  if (input.perTradeMinPct !== undefined) out.perTradeMinPct = num(input.perTradeMinPct, "אחוז מינימלי לעסקה", { min: 0.1, max: 100 });
  if (input.perTradeMaxPct !== undefined) out.perTradeMaxPct = num(input.perTradeMaxPct, "אחוז מקסימלי לעסקה", { min: out.perTradeMinPct, max: 100 });
  if (input.totalExposurePct !== undefined) out.totalExposurePct = num(input.totalExposurePct, "חשיפה כוללת", { min: 1, max: 100 });
  if (input.maxRiskPct !== undefined) out.maxRiskPct = num(input.maxRiskPct, "סיכון מרבי לעסקה", { min: 0.01, max: 20 });
  if (input.minShares !== undefined) out.minShares = num(input.minShares, "כמות מינימלית", { min: 1, max: 1000 });
  if (input.dailyLossPct !== undefined) out.dailyLossPct = num(input.dailyLossPct, "הפסד יומי מרבי", { min: 0.1, max: 100 });
  if (input.minPrice !== undefined) out.minPrice = num(input.minPrice, "סף מחיר תחתון", { min: 0.01, max: 10000 });
  if (input.minAdv20 !== undefined) out.minAdv20 = num(input.minAdv20, "נזילות מינימלית (ADV20)", { min: 0, max: 1e12 });
  if (input.maxAdv20 !== undefined) out.maxAdv20 = num(input.maxAdv20, "נזילות מקסימלית (ADV20)", { min: 0, max: 1e13 });
  if (input.strategies !== undefined) {
    if (!Array.isArray(input.strategies) || !input.strategies.length) fail("יש לבחור לפחות אסטרטגיה אחת");
    out.strategies = [...new Set(input.strategies.map(String))];
  }
  return out;
}

function read() {
  const saved = store.get(KIND, KEY);
  if (!saved) return clone(DEFAULTS);
  try {
    return validate(saved, clone(DEFAULTS));
  } catch {
    return clone(DEFAULTS);
  }
}

function save(input) {
  const next = validate(input, read());
  store.put(KIND, KEY, next);
  return next;
}

module.exports = { KIND, DEFAULTS, validate, read, save };

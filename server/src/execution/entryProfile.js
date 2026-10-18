const store = require("../autopilot/store");

// User-defined entry rules: how signals become a score, and how the score becomes a share count.
// One record, enforced by the server (entryDecision.js). Long only; shorts stay blocked elsewhere.
const KEY = "execution-entry-profile";

const DEFAULTS = Object.freeze({
  // Minutes to collect signals on one symbol before deciding (signals themselves live 10 minutes).
  windowMin: 10,
  // Below this score a symbol is skipped when the window ends.
  minScore: 45,
  // At or above this score the bot enters immediately, without waiting for the window.
  immediateScore: 80,
  // Score by number of agreeing strategy families (1, 2, 3, 4 or more).
  familyPoints: [40, 65, 80, 90],
  // Cap on points added or removed for signal quality (volume, liquidity, stop distance).
  qualityMax: 10,
  // Share of account equity allotted to one trade: from the lowest passing score up to a perfect score.
  perTradeMinPct: 3,
  perTradeMaxPct: 10,
  // Total market value of open positions and pending orders, as a share of equity.
  totalExposurePct: 50,
  // Cap on the loss at the stop, as a share of equity (limits shares when the stop is far).
  maxRiskPct: 0.5,
  // Smallest order the broker accepts (Colmex: 1 lot = 1 share, minimum 10).
  minShares: 10,
});

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function num(value, label, { min, max, integer = false }) {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    fail(`ערך לא תקין: ${label}`);
  return n;
}

function validate(input = {}, base = DEFAULTS) {
  const out = JSON.parse(JSON.stringify(base));
  if (input.windowMin !== undefined) out.windowMin = num(input.windowMin, "חלון איסוף (דקות)", { min: 1, max: 10, integer: true });
  if (input.minScore !== undefined) out.minScore = num(input.minScore, "ציון מינימום", { min: 1, max: 99 });
  if (input.immediateScore !== undefined) out.immediateScore = num(input.immediateScore, "ציון כניסה מיידית", { min: 1, max: 100 });
  if (input.familyPoints !== undefined) {
    if (!Array.isArray(input.familyPoints) || input.familyPoints.length !== 4) fail("יש להגדיר ארבעה ערכי ציון לפי מספר משפחות");
    const pts = input.familyPoints.map((v, i) => num(v, `ציון ל־${i + 1} משפחות`, { min: 0, max: 100 }));
    for (let i = 1; i < pts.length; i++) if (pts[i] < pts[i - 1]) fail("הציון חייב לעלות (או להישאר) ככל שיותר משפחות מסכימות");
    out.familyPoints = pts;
  }
  if (input.qualityMax !== undefined) out.qualityMax = num(input.qualityMax, "תקרת בונוס איכות", { min: 0, max: 30 });
  if (input.perTradeMinPct !== undefined) out.perTradeMinPct = num(input.perTradeMinPct, "אחוז מההון בציון הנמוך", { min: 0.1, max: 100 });
  if (input.perTradeMaxPct !== undefined) out.perTradeMaxPct = num(input.perTradeMaxPct, "אחוז מההון בציון הגבוה", { min: 0.1, max: 100 });
  if (input.totalExposurePct !== undefined) out.totalExposurePct = num(input.totalExposurePct, "חשיפה כוללת", { min: 1, max: 100 });
  if (input.maxRiskPct !== undefined) out.maxRiskPct = num(input.maxRiskPct, "סיכון מרבי לעסקה", { min: 0.01, max: 10 });
  if (input.minShares !== undefined) out.minShares = num(input.minShares, "כמות מינימלית", { min: 1, max: 100000, integer: true });
  if (out.immediateScore < out.minScore) fail("ציון הכניסה המיידית חייב להיות לפחות כמו ציון המינימום");
  if (out.perTradeMaxPct < out.perTradeMinPct) fail("האחוז בציון הגבוה חייב להיות לפחות כמו בציון הנמוך");
  if (out.perTradeMaxPct > out.totalExposurePct) fail("אחוז לעסקה אחת לא יכול לעלות על החשיפה הכוללת");
  return out;
}

function read() {
  const saved = store.get("runtime", KEY);
  if (!saved) return JSON.parse(JSON.stringify(DEFAULTS));
  try {
    return validate(saved, DEFAULTS);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(input) {
  const next = validate(input, read());
  store.put("runtime", KEY, next);
  return next;
}

module.exports = { DEFAULTS, validate, read, save };

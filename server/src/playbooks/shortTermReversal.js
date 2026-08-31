// P4 - short-term reversal (docs/SPEC_V2_ARCHITECTURE.md §5.3). The only mean-reversion playbook
// in the set: buys a sharp, oversold drop while the long-term trend is still intact. Evidence:
// moderate-strong (Lehmann 1990, Jegadeesh 1990) - well documented, and it works precisely when
// momentum-following setups fail, which is real diversification rather than the same idea twice.
const { clamp, normalize } = require('../services/mathUtils');
const { buildTradePlan } = require('../risk/exitEngine');

const STOP_ATR_MULTIPLE = 1.5;
const FALLBACK_TARGET_R = 2;
const TIME_STOP_DAYS = 10;
const HORIZON_DAYS = 10;

const RETURN5D_TRIGGER = -8; // %, "or deeper"
const RSI_TRIGGER = 30; // "or lower"
const RVOL_TRIGGER = 2; // "or higher"

// The MA200 gate is the entire safety mechanism here (§5.3) - not negotiable at any risk tier.
// Without it this playbook just buys a stock on its way to zero.
function isEligible(stock) {
  if (!Number.isFinite(stock?.price) || !Number.isFinite(stock?.ma200) || stock.price <= stock.ma200) {
    return { eligible: false, reason: 'המחיר אינו מעל ממוצע 200 יום - שער הבטיחות המרכזי של השיטה' };
  }
  if (!Number.isFinite(stock?.return5d) || stock.return5d > RETURN5D_TRIGGER) {
    return { eligible: false, reason: `נדרשת ירידה של ${Math.abs(RETURN5D_TRIGGER)}% לפחות ב-5 ימים` };
  }
  if (!Number.isFinite(stock?.rsi14) || stock.rsi14 >= RSI_TRIGGER) {
    return { eligible: false, reason: `נדרש RSI מתחת ל-${RSI_TRIGGER}` };
  }
  if (!Number.isFinite(stock?.rvol) || stock.rvol < RVOL_TRIGGER) {
    return { eligible: false, reason: `נדרש נפח יחסי ${RVOL_TRIGGER}x לפחות` };
  }

  return { eligible: true, reason: null };
}

function buildFactors(stock) {
  return [
    {
      key: 'oversold',
      label: 'רמת מכירת יתר',
      value: normalize(RSI_TRIGGER - stock.rsi14, 0, RSI_TRIGGER),
      detail: `RSI ${Math.round(stock.rsi14)}`
    },
    {
      key: 'dropDepth',
      label: 'חדות הנפילה',
      value: normalize(-stock.return5d, Math.abs(RETURN5D_TRIGGER), 25),
      detail: `${stock.return5d.toFixed(1)}% ב-5 ימים`
    },
    {
      key: 'volumeClimax',
      label: 'נפח קפיטולציה',
      value: normalize(stock.rvol, RVOL_TRIGGER, 6),
      detail: `פי ${stock.rvol.toFixed(1)} מהממוצע`
    },
    {
      key: 'trendCushion',
      label: 'מרווח מעל המגמה הארוכה',
      value: normalize(((stock.price - stock.ma200) / stock.ma200) * 100, 0, 20),
      detail: `${(((stock.price - stock.ma200) / stock.ma200) * 100).toFixed(1)}% מעל ממוצע 200`
    }
  ];
}

// Target is whichever is nearer to entry (the more conservative fill): the reclaim of MA20, or a
// fixed 2R - a violent drop can leave MA20 far overhead, and a distant target that's unlikely to
// be reached in the 10-day time-stop isn't a useful plan (§5.3: "חזרה ל-MA20, או 2R - הקרוב").
function chooseTargetR(stock, stopDistance) {
  if (Number.isFinite(stock.ma20) && stock.ma20 > stock.price && stopDistance > 0) {
    const rToMa20 = (stock.ma20 - stock.price) / stopDistance;
    if (rToMa20 > 0) {
      return Math.min(rToMa20, FALLBACK_TARGET_R);
    }
  }
  return FALLBACK_TARGET_R;
}

function evaluate(stock, context = {}) {
  const gate = isEligible(stock);
  if (!gate.eligible) {
    return { eligible: false, reason: gate.reason, conviction: null, factors: [], plan: null };
  }

  const stopDistance = STOP_ATR_MULTIPLE * stock.atr14;
  const targetR = chooseTargetR(stock, stopDistance);

  const plan = buildTradePlan({
    entryPrice: stock.price,
    atr14: stock.atr14,
    stopMultiple: STOP_ATR_MULTIPLE,
    targetR,
    timeStopDays: TIME_STOP_DAYS,
    accountRiskUsd: context.accountRiskUsd,
    direction: 'long'
  });

  if (!plan.valid) {
    return { eligible: false, reason: plan.invalidReason, conviction: null, factors: [], plan: null };
  }

  const factors = buildFactors(stock);
  const conviction = clamp(factors.reduce((total, factor) => total + factor.value, 0) / factors.length);

  return { eligible: true, reason: null, conviction, factors, plan };
}

module.exports = {
  key: 'short_term_reversal',
  label: 'חזרה לממוצע אחרי נפילה חדה (Short-Term Reversal)',
  status: 'hypothesis',
  evidence: {
    strength: 'moderate',
    sources: ['Lehmann (1990)', 'Jegadeesh (1990)'],
    note: 'תיעוד אקדמי טוב לאפקט ההיפוך הקצר; שער ממוצע 200 יום הוא מנגנון הבטיחות המרכזי ואינו ניתן לעקיפה.'
  },
  horizonDays: HORIZON_DAYS,
  allowedRiskTiers: ['conservative', 'balanced'],
  requiresIntraday: false,
  evaluate
};

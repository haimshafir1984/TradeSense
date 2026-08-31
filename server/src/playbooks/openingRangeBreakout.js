// P2 - opening range breakout (docs/SPEC_V2_ARCHITECTURE.md §5.3). Evidence: moderate-strong
// (Zarattini/Barbon/Aziz 2024) but with a material caveat - the paper's headline return came
// almost entirely from its relative-volume selection filter (29% unfiltered vs 1,637% filtered),
// and it assumed zero slippage against a 0.10x ATR14 stop, which is about as tight as a stop gets.
//
// §12 decision 3: built here, but gated behind ORB_ENABLED (default off, §11 criterion 10 - off
// must behave exactly as if this file didn't exist) and NOT wired into the live pipeline yet -
// requiresIntraday: true, and runScan/candidatesService don't fetch intraday bars in v1. This
// module is complete and tested on its own; a future phase that turns the flag on also has to
// teach the pipeline to populate the opening-range fields it reads below.
const { clamp, normalize } = require('../services/mathUtils');
const { buildTradePlan } = require('../risk/exitEngine');

const STOP_ATR_MULTIPLE = 0.1; // deliberately very tight - §5.3's own words: "צמוד מאוד"
// The source paper's "stocks in play" variant didn't use a fixed R target (rides to close); the
// 10R figure is carried over from its QQQ/TQQQ sibling paper as the closest documented number
// this codebase has - an acknowledged approximation, not a literal spec value. Since the position
// exits at end of day regardless, this mostly matters as a display figure.
const APPROXIMATE_TARGET_R = 10;
const TIME_STOP_DAYS = 1; // same trading day
const HORIZON_DAYS = 1;

function resolveDirection(stock) {
  if (stock?.openingRangeDirection === 'up') {
    return 'long';
  }
  if (stock?.openingRangeDirection === 'down') {
    return 'short';
  }
  return null;
}

function isEligible(stock) {
  if (!Number.isFinite(stock?.openingRangeHigh) || !Number.isFinite(stock?.openingRangeLow)) {
    // The pipeline doesn't populate these yet (no intraday bars wired in v1) - this is the
    // expected, permanent state while ORB_ENABLED stays off.
    return { eligible: false, reason: 'אין נתוני טווח פתיחה תוך-יומיים (נדרשים נרות 5 דקות, לא זמינים ב-v1)' };
  }

  const direction = resolveDirection(stock);
  if (!direction) {
    return { eligible: false, reason: 'כיוון נר הפתיחה לא ידוע' };
  }

  if (direction === 'long' && !(Number(stock.price) > stock.openingRangeHigh)) {
    return { eligible: false, reason: 'המחיר לא פרץ מעל שיא נר הפתיחה' };
  }
  if (direction === 'short' && !(Number(stock.price) < stock.openingRangeLow)) {
    return { eligible: false, reason: 'המחיר לא שבר מתחת לשפל נר הפתיחה' };
  }
  if (!Number.isFinite(stock.rvol) || stock.rvolBasis !== 'opening') {
    return { eligible: false, reason: 'נדרש נפח יחסי מבוסס פתיחה (rvolOpening) - זוהי שכבת הבחירה שנושאת את מרבית ה-edge' };
  }

  return { eligible: true, reason: null, direction };
}

function buildFactors(stock, direction) {
  const breakoutDistancePct =
    direction === 'long'
      ? ((stock.price - stock.openingRangeHigh) / stock.openingRangeHigh) * 100
      : ((stock.openingRangeLow - stock.price) / stock.openingRangeLow) * 100;

  return [
    {
      key: 'openingRvol',
      label: 'נפח יחסי בפתיחה',
      value: normalize(stock.rvol, 1.5, 5),
      detail: `פי ${stock.rvol.toFixed(1)} מהממוצע (5 דקות ראשונות)`
    },
    {
      key: 'breakoutStrength',
      label: 'עוצמת הפריצה',
      value: normalize(breakoutDistancePct, 0, 2),
      detail: `${breakoutDistancePct.toFixed(2)}% מעבר לטווח הפתיחה`
    }
  ];
}

function evaluate(stock, context = {}) {
  const gate = isEligible(stock);
  if (!gate.eligible) {
    return { eligible: false, reason: gate.reason, conviction: null, factors: [], plan: null };
  }

  const plan = buildTradePlan({
    entryPrice: stock.price,
    atr14: stock.atr14,
    stopMultiple: STOP_ATR_MULTIPLE,
    targetR: APPROXIMATE_TARGET_R,
    timeStopDays: TIME_STOP_DAYS,
    accountRiskUsd: context.accountRiskUsd,
    direction: gate.direction
  });

  if (!plan.valid) {
    return { eligible: false, reason: plan.invalidReason, conviction: null, factors: [], plan: null };
  }

  const factors = buildFactors(stock, gate.direction);
  const conviction = clamp(factors.reduce((total, factor) => total + factor.value, 0) / factors.length);

  return { eligible: true, reason: null, conviction, factors, plan };
}

module.exports = {
  key: 'opening_range_breakout',
  label: 'פריצת טווח פתיחה (Opening Range Breakout)',
  status: 'hypothesis',
  evidence: {
    strength: 'moderate',
    sources: ['Zarattini, Barbon & Aziz (2024)'],
    note:
      'ה-edge בפועל הגיע כמעט כולו מפילטר הבחירה (29% ללא פילטר נפח יחסי מול 1,637% איתו), לא מהתבנית עצמה. ' +
      'המאמר הניח אפס slippage מול סטופ צמוד של 0.10×ATR14 - רגיש קריטית לתנאי ביצוע אמיתיים. יעד ה-10R הועתק מהמאמר הדומה על QQQ/TQQQ; המאמר על "stocks in play" עצמו לא השתמש ביעד קבוע.'
  },
  horizonDays: HORIZON_DAYS,
  allowedRiskTiers: ['aggressive'],
  requiresIntraday: true,
  evaluate
};

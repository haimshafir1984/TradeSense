// P1 - post-earnings-announcement drift (docs/SPEC_V2_ARCHITECTURE.md §5.3). The strongest
// evidence in the whole set: Ball & Brown (1968), rigorously quantified by Bernard & Thomas (1989),
// documented excess return of 2.6%-9.37% per quarter. Known caveat that must travel with every use
// of this playbook: the effect has weakened over decades and is sensitive to trading costs.
//
// "Day-of-earnings return" (§5.3's trigger) is approximated as the stock's most recent daily
// return (features.js#dailyChangePct) - this file only sees daily bars, not the exact intraday
// reaction candle, so it relies on the eligibility window (daysSinceEarnings <= 3) to keep that
// approximation close to the actual reaction day.
const { clamp, normalize } = require('../services/mathUtils');
const { buildTradePlan } = require('../risk/exitEngine');

const STOP_ATR_MULTIPLE = 2.5;
const TARGET_R = 3;
const TIME_STOP_DAYS = 30;
// §5.3 lists a 20-60 trading-day horizon, but the 30-day time-stop is what actually closes an
// unproductive trade - horizonDays (per the §5.3 evaluate() contract, a single number) reflects
// that practical ceiling rather than the wider descriptive range, which stays in evidence.note.
const HORIZON_DAYS = TIME_STOP_DAYS;

const SURPRISE_TRIGGER_PCT = 5;
const DAY_RETURN_TRIGGER_PCT = 2;
const RECENT_EARNINGS_WINDOW_DAYS = 3;

function isEligible(stock) {
  const catalyst = stock?.catalyst;

  if (!catalyst || catalyst.kind !== 'earnings_surprise') {
    return { eligible: false, reason: 'אין הפתעת רווחים מספרית טרייה (0-3 ימי מסחר אחרונים)' };
  }
  if (!Number.isFinite(catalyst.daysSinceEarnings) || catalyst.daysSinceEarnings > RECENT_EARNINGS_WINDOW_DAYS) {
    return { eligible: false, reason: `הדוח פורסם לפני יותר מ-${RECENT_EARNINGS_WINDOW_DAYS} ימי מסחר` };
  }
  if (!Number.isFinite(catalyst.earningsSurprisePct) || catalyst.earningsSurprisePct < SURPRISE_TRIGGER_PCT) {
    return { eligible: false, reason: `נדרשת הפתעת רווחים של ${SURPRISE_TRIGGER_PCT}%+ ` };
  }
  if (!Number.isFinite(stock?.dailyChangePct) || stock.dailyChangePct < DAY_RETURN_TRIGGER_PCT) {
    return { eligible: false, reason: `נדרשת תשואה של +${DAY_RETURN_TRIGGER_PCT}%+ ביום התגובה לדוח` };
  }

  return { eligible: true, reason: null };
}

function buildFactors(stock) {
  const catalyst = stock.catalyst;
  const highProximity = Number.isFinite(stock.high52w) && stock.high52w > 0 ? stock.price / stock.high52w : null;

  const factors = [
    {
      key: 'surpriseSize',
      label: 'גודל ההפתעה',
      value: normalize(catalyst.earningsSurprisePct, SURPRISE_TRIGGER_PCT, 30),
      detail: `הפתעת רווחים ${catalyst.earningsSurprisePct.toFixed(1)}%`
    },
    {
      key: 'dayReaction',
      label: 'עוצמת תגובת היום',
      value: normalize(stock.dailyChangePct, DAY_RETURN_TRIGGER_PCT, 15),
      detail: `${stock.dailyChangePct.toFixed(1)}% ביום התגובה`
    }
  ];

  if (Number.isFinite(stock.rvol)) {
    factors.push({
      key: 'volumeOnReaction',
      label: 'נפח יחסי בתגובה לדוח',
      value: normalize(stock.rvol, 1.5, 5),
      detail: `פי ${stock.rvol.toFixed(1)} מהממוצע`
    });
  }

  if (highProximity !== null) {
    factors.push({
      key: 'highProximity',
      label: 'מרחק מהשיא',
      value: normalize(highProximity, 0.7, 1),
      detail: `${(highProximity * 100).toFixed(1)}% מהשיא ב-52 שבועות`
    });
  }

  return factors;
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
    targetR: TARGET_R,
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
  key: 'pead_drift',
  label: 'דריפט אחרי הפתעת רווחים (PEAD)',
  status: 'hypothesis',
  evidence: {
    strength: 'strong',
    sources: ['Ball & Brown (1968)', 'Bernard & Thomas (1989)'],
    note: 'התשואה העודפת התועדת (2.6%-9.37% לרבעון) נחלשת עם השנים ורגישה לעלויות מסחר - הראיה החזקה ביותר בסט, לא הכי גבוהה בתשואה. אופק תיאורטי 20-60 יום, אך ה-time-stop של 30 יום הוא שסוגר בפועל עסקה שלא הבשילה.'
  },
  horizonDays: HORIZON_DAYS,
  allowedRiskTiers: ['conservative', 'balanced'],
  requiresIntraday: false,
  evaluate
};

// P3 - gap continuation (docs/SPEC_V2_ARCHITECTURE.md §5.3). The weakest evidence in the set -
// sourced from trading blogs, not peer-reviewed research. That caveat is mandatory in evidence.note
// (§5.3) and must never be dropped, even though this is otherwise the closest playbook to a plain
// "big gap + volume" setup.
//
// A gap with no identified catalyst is rejected outright (§5.3: "גאפ ללא קטליזטור נדחה") - that's
// exactly the symmetric-noise case §0 warns against trusting, so catalyst.confidence must be
// 'high' or 'medium' (i.e. anything but null or the 'gap_no_news' kind, which is always 'low').
const { clamp, normalize } = require('../services/mathUtils');
const { buildTradePlan } = require('../risk/exitEngine');

const ATR_STOP_MULTIPLE = 1.0;
const TARGET_R = 2;
const TIME_STOP_DAYS = 3;
const HORIZON_DAYS = TIME_STOP_DAYS;

const GAP_TRIGGER_PCT = 3;
const RVOL_TRIGGER = 2;

// Prefers the live premarket snapshot gap (catalystService) over the bar-based approximation
// (features.js#gapPct) - the live figure is the more accurate measurement when it's available.
function resolveGapPct(stock) {
  const liveGap = stock?.catalyst?.premarketGapPct;
  return Number.isFinite(liveGap) ? liveGap : stock?.gapPct;
}

function isEligible(stock) {
  const gapPct = resolveGapPct(stock);
  const catalyst = stock?.catalyst;

  if (!Number.isFinite(gapPct) || Math.abs(gapPct) < GAP_TRIGGER_PCT) {
    return { eligible: false, reason: `נדרש גאפ של ${GAP_TRIGGER_PCT}%+ (בפועל ${Number.isFinite(gapPct) ? gapPct.toFixed(1) : 'לא ידוע'}%)` };
  }
  if (!Number.isFinite(stock?.rvol) || stock.rvol < RVOL_TRIGGER) {
    return { eligible: false, reason: `נדרש נפח יחסי ${RVOL_TRIGGER}x לפחות` };
  }
  if (!catalyst || catalyst.confidence === 'low' || catalyst.kind === null) {
    return { eligible: false, reason: 'גאפ ללא קטליזטור מזוהה נדחה - תנועה בלי סיבה היא רעש סימטרי' };
  }

  return { eligible: true, reason: null, gapPct };
}

// Entry is the opening price - this playbook's trigger is nominally "breakout of the first 15
// minutes' high", but without intraday bars (requiresIntraday: false, §5.3) it degrades to the
// day's own open, exactly as the spec's own fallback describes.
function resolveEntryPrice(stock) {
  return Number.isFinite(stock?.open) ? stock.open : stock?.price;
}

// Stop is whichever is nearer to entry: 1x ATR14, or below the premarket low when that's known
// (§5.3). premarketLow isn't wired into the pipeline yet (no intraday bars until phase 9) - when
// absent this simply falls back to the ATR-only stop, which is the correct degraded behavior, not
// a broken one.
function resolveStopMultiple(stock, entryPrice) {
  const atrDistance = ATR_STOP_MULTIPLE * stock.atr14;

  if (Number.isFinite(stock.premarketLow) && stock.premarketLow < entryPrice) {
    const premarketDistance = entryPrice - stock.premarketLow;
    const nearerDistance = Math.min(atrDistance, premarketDistance);
    return nearerDistance / stock.atr14;
  }

  return ATR_STOP_MULTIPLE;
}

function buildFactors(stock, gapPct) {
  return [
    {
      key: 'gapSize',
      label: 'גודל הגאפ',
      value: normalize(Math.abs(gapPct), GAP_TRIGGER_PCT, 15),
      detail: `${gapPct.toFixed(1)}%`
    },
    {
      key: 'volumeConfirmation',
      label: 'אישור נפח',
      value: normalize(stock.rvol, RVOL_TRIGGER, 6),
      detail: `פי ${stock.rvol.toFixed(1)} מהממוצע`
    },
    {
      key: 'catalystConfidence',
      label: 'ביטחון בקטליזטור',
      value: stock.catalyst.confidence === 'high' ? 1 : 0.5,
      detail: stock.catalyst.kind
    }
  ];
}

function evaluate(stock, context = {}) {
  const gate = isEligible(stock);
  if (!gate.eligible) {
    return { eligible: false, reason: gate.reason, conviction: null, factors: [], plan: null };
  }

  const entryPrice = resolveEntryPrice(stock);
  const stopMultiple = resolveStopMultiple(stock, entryPrice);

  const plan = buildTradePlan({
    entryPrice,
    atr14: stock.atr14,
    stopMultiple,
    targetR: TARGET_R,
    timeStopDays: TIME_STOP_DAYS,
    accountRiskUsd: context.accountRiskUsd,
    direction: 'long'
  });

  if (!plan.valid) {
    return { eligible: false, reason: plan.invalidReason, conviction: null, factors: [], plan: null };
  }

  const factors = buildFactors(stock, gate.gapPct);
  const conviction = clamp(factors.reduce((total, factor) => total + factor.value, 0) / factors.length);

  return { eligible: true, reason: null, conviction, factors, plan };
}

module.exports = {
  key: 'gap_continuation',
  label: 'המשך גאפ (Gap Continuation)',
  status: 'hypothesis',
  evidence: {
    strength: 'weak',
    sources: ['מקורות מסחריים (trading blogs) - לא שפיטים'],
    note: 'הנתון של ~60% המשכיות מגיע ממקור מסחרי לא שפיט; יש להתייחס אליו כהשערה בלבד. הראיה החלשה ביותר בסט.'
  },
  horizonDays: HORIZON_DAYS,
  allowedRiskTiers: ['balanced', 'aggressive'],
  requiresIntraday: false,
  evaluate
};

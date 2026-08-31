// The component that didn't exist in v1 and is the main reason for the rebuild
// (docs/SPEC_V2_ARCHITECTURE.md §5.4). Every candidate the pipeline shows must carry a complete
// trade plan from here - a candidate whose plan is invalid is dropped entirely (§1 rule 4), never
// shown with a missing/fabricated exit.
const { round } = require('../services/mathUtils');

// Builds a complete trade plan from an entry price and a stop distance defined in ATR multiples.
// Pure function, no I/O - every input is a plain number the caller already computed.
//
// direction is additive to the §5.4 signature (long/short), defaulting to 'long' since every
// playbook shipped so far is long-only - kept general so a future short-biased playbook doesn't
// need a second exit engine.
function buildTradePlan({
  entryPrice,
  atr14,
  stopMultiple,
  targetR,
  timeStopDays,
  accountRiskUsd,
  direction = 'long'
}) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return invalidPlan(timeStopDays, 'מחיר כניסה חסר או לא תקין');
  }
  if (!Number.isFinite(atr14) || atr14 <= 0) {
    return invalidPlan(timeStopDays, 'atr14 חסר או לא תקין');
  }
  if (!Number.isFinite(stopMultiple) || stopMultiple <= 0) {
    return invalidPlan(timeStopDays, 'מכפיל סטופ חסר או לא תקין');
  }
  if (!Number.isFinite(targetR) || targetR <= 0) {
    return invalidPlan(timeStopDays, 'יעד R חסר או לא תקין');
  }
  if (direction !== 'long' && direction !== 'short') {
    return invalidPlan(timeStopDays, `כיוון לא מוכר: ${direction}`);
  }

  const stopDistance = round(stopMultiple * atr14, 4);
  if (!(stopDistance > 0)) {
    return invalidPlan(timeStopDays, 'מרחק סטופ אפס');
  }

  const stopPrice = direction === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
  if (stopPrice <= 0) {
    return invalidPlan(timeStopDays, 'מחיר סטופ שלילי או אפס');
  }

  const targetDistance = round(targetR * stopDistance, 4);
  const targetPrice = direction === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance;
  const gainPct = round((targetDistance / entryPrice) * 100, 2);
  const distancePct = round((stopDistance / entryPrice) * 100, 2);

  return {
    entry: { price: round(entryPrice, 2), type: 'market' },
    stop: {
      price: round(stopPrice, 2),
      distancePct,
      distanceR: 1,
      basis: `atr14 × ${stopMultiple}`
    },
    target: {
      price: round(targetPrice, 2),
      rMultiple: targetR,
      // Purely a mathematical consequence of the stop distance and R multiple - not a return
      // forecast (§5.4). Never label this as "expected"/"predicted" anywhere it's displayed.
      gainPct
    },
    timeStopDays,
    sizing: buildSizing({ accountRiskUsd, entryPrice, stopPrice }),
    valid: true,
    invalidReason: null
  };
}

function invalidPlan(timeStopDays, reason) {
  return {
    entry: null,
    stop: null,
    target: null,
    timeStopDays: timeStopDays ?? null,
    sizing: null,
    valid: false,
    invalidReason: reason
  };
}

// null (not 0) when accountRiskUsd isn't supplied - "unknown budget" must stay distinguishable
// from "budget too small for even one share" (§5.4).
function buildSizing({ accountRiskUsd, entryPrice, stopPrice }) {
  if (!Number.isFinite(accountRiskUsd) || accountRiskUsd <= 0) {
    return null;
  }

  const perShareRisk = Math.abs(entryPrice - stopPrice);
  if (!(perShareRisk > 0)) {
    return null;
  }

  const shares = Math.floor(accountRiskUsd / perShareRisk);
  return {
    shares,
    riskUsd: round(shares * perShareRisk, 2),
    notionalUsd: round(shares * entryPrice, 2)
  };
}

module.exports = {
  buildTradePlan
};

const { round } = require('./mathUtils');

// A mechanical stop-distance/reward-risk calculation shown alongside each result - not a
// recommendation to enter or exit a position, and not investment advice. Sized off the stock's
// own daily volatility (ADR%, already computed in marketDataService/barsStockBuilder) rather than
// a fixed percentage, so a quiet stock and a wild one don't get the same suggested stop. See
// docs/SPEC_SHORT_TERM_UPGRADE.md step 2.
const MIN_STOP_DISTANCE_PCT = 3;
const ADR_STOP_MULTIPLIER = 1;

function computeRiskFraming({ stock, estimatedUpside }) {
  const adrPct = Number(stock?.adr_pct);
  const price = Number(stock?.price);
  // adr_pct can be a seeded/imputed placeholder rather than a real observed value (see
  // docs/LOGIC_IMPROVEMENTS.md 2.4) - a stop distance built on a fabricated number is worse than
  // no stop distance at all, so this is left null rather than silently using it.
  const adrIsImputed = (stock?.imputedFields || []).includes('adr_pct');

  if (!Number.isFinite(adrPct) || adrPct <= 0 || adrIsImputed || !Number.isFinite(price) || price <= 0) {
    return { stopDistancePct: null, stopPrice: null, rewardRiskRatio: null };
  }

  const stopDistancePct = round(Math.max(adrPct * ADR_STOP_MULTIPLIER, MIN_STOP_DISTANCE_PCT), 1);
  const stopPrice = round(price * (1 - stopDistancePct / 100), 2);

  const midUpsidePct = Number(estimatedUpside?.midPct);
  const rewardRiskRatio = Number.isFinite(midUpsidePct) && stopDistancePct > 0
    ? round(midUpsidePct / stopDistancePct, 2)
    : null;

  return { stopDistancePct, stopPrice, rewardRiskRatio };
}

module.exports = {
  computeRiskFraming
};

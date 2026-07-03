// Central place for the scoring "magic numbers" that used to be scattered inline across
// strategies.js/analysisService.js/scannerService.js. Pulling them here doesn't change behavior
// on its own, but it's the precondition for future calibration/A-B testing work (see
// docs/LOGIC_IMPROVEMENTS.md section 4 and 5.1) - one place to tune instead of hunting through
// scoring functions.

// Top-level weights each strategy applies to its own sub-factors. These must each sum to 1.
const STRATEGY_WEIGHTS = {
  micha_stocks: { trend: 0.35, growth: 0.25, pullback: 0.2, volume: 0.2 },
  mark_minervini: { momentum: 0.3, trend: 0.25, volume: 0.2, breakout: 0.25 },
  ross_cameron: { momentum: 0.4, volume: 0.3, breakout: 0.2, float: 0.1 }
};

// Percentile-within-universe thresholds used by assessCrossStrategyConfluence (see 3.6).
const CONFLUENCE_THRESHOLDS = {
  highSelectedPercentile: 75,
  mediumSelectedPercentile: 65,
  supportingPercentile: 60,
  strongAgreementPercentile: 70
};

// Below this (risk-adjusted) score a stock isn't shown as a recommendation (see 3.8).
const QUALITY_SCORE_THRESHOLD = 0.35;

// Ideal/hard bounds for the continuous risk-fit penalty taper (see 3.5).
const RISK_FIT_THRESHOLDS = {
  low: {
    volatilityIdeal: 0.03,
    volatilityHard: 0.07,
    marketCapIdeal: 5000000000,
    marketCapHard: 1000000000,
    imputedCriticalPenalty: 0.6
  },
  medium: {
    volatilityIdeal: 0.055,
    volatilityHard: 0.09
  },
  minPenalty: 0.15
};

module.exports = {
  STRATEGY_WEIGHTS,
  CONFLUENCE_THRESHOLDS,
  QUALITY_SCORE_THRESHOLD,
  RISK_FIT_THRESHOLDS
};

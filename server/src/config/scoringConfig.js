// Central place for the scoring "magic numbers" that used to be scattered inline across
// strategies.js/analysisService.js/scannerService.js. Pulling them here doesn't change behavior
// on its own, but it's the precondition for future calibration/A-B testing work (see
// docs/LOGIC_IMPROVEMENTS.md section 4 and 5.1) - one place to tune instead of hunting through
// scoring functions.

// Top-level weights each strategy applies to its own sub-factors. These must each sum to 1.
// swing_momentum is the exception: its score is max(breakout, episodicPivot) rather than a single
// blend (see scoreSwingMomentumStrategy), so its two sub-groups each sum to 1 independently.
const STRATEGY_WEIGHTS = {
  micha_stocks: { trend: 0.35, growth: 0.25, pullback: 0.2, volume: 0.2 },
  mark_minervini: { momentum: 0.3, trend: 0.25, volume: 0.2, breakout: 0.25 },
  ross_cameron: { momentum: 0.4, volume: 0.3, breakout: 0.2, float: 0.1 },
  swing_momentum: {
    breakout: { consolidation: 0.25, highProximity: 0.25, volume: 0.2, relativeStrength: 0.2, trend: 0.1 },
    episodicPivot: { move: 0.6, volume: 0.4 }
  }
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

// Default strategy recommendation per market regime, used only when the strategy league
// (scanHistoryService.js) doesn't yet have a measured leader - see marketRegimeService.js
// resolveRecommendedStrategy and docs/LOGIC_IMPROVEMENTS.md. bearish -> null means "sit out",
// not "pick something anyway".
const REGIME_RECOMMENDED_STRATEGY = {
  bullish: 'swing_momentum',
  sideways: 'micha_stocks',
  volatile: 'ross_cameron',
  bearish: null
};

// Eligibility bounds for small_cap_breakout, shared between the strategy's own filter
// (strategies.js) and the dedicated small-cap universe's FMP screener query
// (smallCapUniverseService.js) so the two definitions of "small cap" can't drift apart. See
// docs/SPEC_SMALL_CAP_STRATEGY.md.
const SMALL_CAP_THRESHOLDS = {
  marketCapCeiling: 2000000000,
  minPrice: 2,
  minAdrPct: 5
};

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
  RISK_FIT_THRESHOLDS,
  REGIME_RECOMMENDED_STRATEGY,
  SMALL_CAP_THRESHOLDS
};

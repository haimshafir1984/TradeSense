const { getMarketData, getStockSnapshots } = require('./marketDataService');
const { getSmallCapUniverse } = require('./smallCapUniverseService');
const { scoreStockByStrategy } = require('./strategies');
const { clamp, round } = require('./mathUtils');
const {
  STRATEGY_KEYS,
  assessDataQuality,
  validateResults,
  computeConfidence,
  assessCrossStrategyConfluence,
  buildStrategyScoreDistributions,
  assessRiskOverlay,
  buildSummary,
  groupResults,
  summarizeResultLayers
} = require('./analysisService');
const { enrichExplanation } = require('./explanationService');
const {
  STRATEGY_DISPLAY_LABELS,
  assessExpertSupport,
  summarizeExpertSupport
} = require('./expertSupportService');
const {
  MARKET_BENCHMARKS,
  assessMarketRegime,
  computeRegimeAdjustedConfidence
} = require('./marketRegimeService');
const {
  assessOpportunity,
  summarizeOpportunity
} = require('./opportunityScoringService');
const { assessIndiFit } = require('./indiOverlayService');
const { QUALITY_SCORE_THRESHOLD, RISK_FIT_THRESHOLDS } = require('../config/scoringConfig');
const { recordScan, getLeagueSnapshot } = require('./scanHistoryService');

async function analyzeMarket(request = {}) {
  const exchange = request.exchange || 'NASDAQ';
  const strategy = request.strategy || 'micha_stocks';
  const risk = request.risk || 'medium';
  const filters = request.filters || {};

  console.log('[analyze] Incoming request', {
    exchange,
    strategy,
    risk,
    filters
  });

  const [marketDataResult, benchmarkSnapshots] = await Promise.all([
    strategy === 'small_cap_breakout' ? getSmallCapMarketData(exchange) : getMarketData(exchange),
    getStockSnapshots(MARKET_BENCHMARKS)
  ]);
  const { stocks, source, isStale, usedDedicatedUniverse } = marketDataResult;
  const dataQuality = assessDataQuality({ stocks, source });

  // The dedicated small-cap universe (Alpaca-backed) replaces the regular universe entirely for
  // this strategy - it's structurally useless on the regular ~40-mega-cap universe (see
  // docs/SPEC_SMALL_CAP_STRATEGY.md). If it wasn't available, getSmallCapMarketData already fell
  // back to the regular universe below; surface that honestly instead of silently scoring
  // mega-caps against a small-cap eligibility filter that will reject almost everything.
  if (strategy === 'small_cap_breakout' && !usedDedicatedUniverse) {
    dataQuality.issues.push('האסטרטגיה דורשת מאגר מניות קטנות (Alpaca) שאינו זמין כרגע - הסריקה רצה על המאגר הרגיל');
  }

  // Surfaces the freshness policy from docs/SPEC_UNIVERSE_RESILIENCE.md section 4.3 - a universe
  // that's 24-72h old is still real, live data (not demo), but the user should know it's not
  // tonight's refresh.
  if (isStale) {
    dataQuality.issues.push('רשימת המניות מבוססת על סריקת אתמול/שלשום (רענון לילי נכשל) - הנתונים עדיין אמיתיים, לא דמו');
  }
  const spyBenchmark = benchmarkSnapshots.find((snapshot) => snapshot?.ticker === 'SPY');
  const marketContext = { benchmarkReturn3m: Number(spyBenchmark?.return_3m || 0) };
  const filteredStocks = stocks.filter((stock) => applyFilters(stock, filters));
  const scoreDistributions = buildStrategyScoreDistributions(filteredStocks, marketContext);
  const scoredStocks = filteredStocks
    .map((stock) => scoreStockByStrategy(strategy, stock, marketContext))
    .map((stock) => applyRiskFitPenalty(stock, risk))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);
  // Returning the "best" 10 stocks even when every one of them is a weak match misrepresents a
  // scan with nothing worth acting on as if it found opportunities. Below this score, a stock
  // isn't shown as a recommendation - see docs/LOGIC_IMPROVEMENTS.md 3.8.
  const qualityStocks = scoredStocks.filter((stock) => stock.score >= QUALITY_SCORE_THRESHOLD);
  const noQualitySetups = scoredStocks.length > 0 && qualityStocks.length === 0;
  const validation = validateResults({ results: scoredStocks });
  const confidenceScore = computeConfidence({
    dataQuality,
    validation,
    results: scoredStocks,
    source
  });
  // Best-effort: a strategy league with a measured leader should override the regime-based
  // default recommendation, but the league snapshot isn't essential to serving the scan itself.
  let leagueSnapshot = null;
  try {
    leagueSnapshot = await getLeagueSnapshot();
  } catch (error) {
    console.warn('[analyze] Failed to load strategy league snapshot', error.message);
  }

  const marketRegime = assessMarketRegime({
    snapshots: benchmarkSnapshots,
    selectedStrategy: strategy,
    universeStocks: stocks,
    league: leagueSnapshot
  });
  const adjustedConfidenceScore = computeRegimeAdjustedConfidence(confidenceScore, marketRegime);
  const results = qualityStocks.map((stock) => {
    const matchScore = Math.round(stock.score * 100);
    const deterministicExplanation = stock.explanation;
    const confluence = assessCrossStrategyConfluence({
      stock,
      selectedStrategy: strategy,
      marketContext,
      scoreDistributions
    });
    const expertSupport = assessExpertSupport({
      stock,
      selectedStrategy: strategy
    });
    const riskOverlay = assessRiskOverlay({
      stock,
      dataQuality,
      strategy
    });
    const opportunity = assessOpportunity({
      stock,
      strategy,
      confidenceScore: adjustedConfidenceScore,
      riskOverlay,
      marketRegime
    });
    const indiFit = assessIndiFit({
      stock,
      strategy,
      opportunity,
      riskOverlay,
      marketRegime
    });

    return {
      ticker: stock.ticker,
      companyName: stock.companyName,
      matchScore,
      strategyName: STRATEGY_DISPLAY_LABELS[strategy] || STRATEGY_DISPLAY_LABELS.micha_stocks,
      explanation: deterministicExplanation,
      enrichedExplanation: enrichExplanation({
        stock,
        strategy,
        deterministicExplanation,
        dataQuality,
        confluence,
        riskOverlay,
        expertSupport
      }),
      confidenceScore: adjustedConfidenceScore,
      dataSource: stock.data_source || source,
      imputedFields: stock.imputedFields || [],
      riskFitPenalty: stock.riskFitPenalty,
      expertSupport,
      confluence,
      riskOverlay,
      opportunity,
      indiFit,
      opportunityRank: opportunity.opportunityRank,
      estimatedUpsideRange: opportunity.estimatedUpside.label,
      expectedReturnPct: opportunity.expectedReturnPct,
      opportunityScore: opportunity.opportunityScore,
      price: round(stock.price, 2),
      volatility: round(stock.volatility, 4),
      market_cap: Math.round(stock.market_cap)
    };
  });
  const layerSummary = summarizeResultLayers(results);
  const expertSupportSummary = summarizeExpertSupport(results);
  const opportunitySummary = summarizeOpportunity(results);
  const summary = buildSummary({
    results,
    confidenceScore: adjustedConfidenceScore,
    dataQuality,
    validation,
    confluenceSummary: layerSummary.confluence,
    riskSummary: layerSummary.risk,
    expertSupportSummary,
    opportunitySummary
  });
  const groups = groupResults(results);

  console.log('[analyze] Completed scan', {
    exchange,
    strategy,
    source,
    totalStocks: stocks.length,
    filteredStocks: filteredStocks.length,
    returnedStocks: results.length,
    noQualitySetups
  });

  // Persisting scans is what makes it possible to later check whether opportunityRank etc. mean
  // anything (see evaluateOutcomes/buildHitRateReport in scanHistoryService.js). Best-effort: a
  // storage failure shouldn't fail the scan response itself.
  try {
    // Also score every other strategy against the same filtered universe so the strategy league
    // (docs/LOGIC_IMPROVEMENTS.md - Strategy League) can measure how each strategy would have
    // done, not just the one the user happened to pick.
    const strategyTopPicks = buildStrategyTopPicks(filteredStocks, marketContext, risk);
    await recordScan({ exchange, strategy, risk, results, spyPriceAtScan: spyBenchmark?.price, strategyTopPicks });
  } catch (error) {
    console.warn('[analyze] Failed to record scan history', error.message);
  }

  return {
    results,
    meta: {
      exchange,
      strategy,
      risk,
      source,
      analyzedCount: filteredStocks.length,
      returnedCount: results.length,
      noQualitySetups,
      confidenceScore: adjustedConfidenceScore,
      baseConfidenceScore: confidenceScore
    },
    analysis: {
      dataQuality,
      validation,
      confidenceScore: adjustedConfidenceScore,
      baseConfidenceScore: confidenceScore,
      marketRegime,
      overlays: {
        ...layerSummary,
        expertSupport: expertSupportSummary,
        opportunity: opportunitySummary
      },
      summary,
      groups
    }
  };
}

// Tries the dedicated small-cap universe first; falls back to the regular universe (same as every
// other strategy) whenever it's unavailable - the source string is how the caller tells which one
// actually happened, without a separate side-channel flag.
async function getSmallCapMarketData(exchange) {
  const smallCapStocks = await getSmallCapUniverse({ exchange });

  if (Array.isArray(smallCapStocks) && smallCapStocks.length) {
    // Every stock in the batch carries the same data_source/dataStale (the whole universe came
    // from one screener call - see smallCapUniverseService.js), so the first entry's labels are
    // authoritative for the whole result. Reading data_source here (instead of hardcoding
    // 'alpaca+fmp-screener') keeps this in sync now that the screener itself can be Nasdaq,
    // Alpaca+Finnhub, or FMP - see docs/SPEC_PROVIDER_REBALANCE.md section 5.1 and
    // docs/SPEC_UNIVERSE_RESILIENCE.md. usedDedicatedUniverse (rather than comparing the source
    // string) is what tells the caller below whether this actually is the small-cap-specific
    // universe, since every one of those three source values is a legitimate "it worked" outcome.
    return {
      stocks: smallCapStocks,
      source: smallCapStocks[0].data_source || 'alpaca+fmp-screener',
      isStale: smallCapStocks[0].dataStale === true,
      usedDedicatedUniverse: true
    };
  }

  const regular = await getMarketData(exchange);
  return { ...regular, usedDedicatedUniverse: false };
}

const STRATEGY_LEAGUE_TOP_N = 5;

function buildStrategyTopPicks(filteredStocks, marketContext, risk) {
  const topPicks = {};

  for (const strategyKey of STRATEGY_KEYS) {
    topPicks[strategyKey] = filteredStocks
      .map((stock) => scoreStockByStrategy(strategyKey, stock, marketContext))
      .map((stock) => applyRiskFitPenalty(stock, risk))
      .sort((left, right) => right.score - left.score)
      .slice(0, STRATEGY_LEAGUE_TOP_N)
      .map((stock) => ({ ticker: stock.ticker, price: round(stock.price, 2), score: round(stock.score, 4) }));
  }

  return topPicks;
}

function applyFilters(stock, filters) {
  const minDividendYield = toNumber(filters.minDividendYield);
  const minVolume = toNumber(filters.minVolume);
  const minPrice = toNumber(filters.minPrice);
  const maxPrice = toNumber(filters.maxPrice);
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;

  if (filters.dividendOnly && stock.dividend_yield <= 0) {
    return false;
  }

  if (minDividendYield && stock.dividend_yield < minDividendYield) {
    return false;
  }

  if (filters.sector && filters.sector !== 'Any' && stock.sector !== filters.sector) {
    return false;
  }

  if (!matchesMarketCap(stock.market_cap, filters.marketCap)) {
    return false;
  }

  if (minVolume && stock.volume < minVolume) {
    return false;
  }

  if (minPrice && stock.price < minPrice) {
    return false;
  }

  if (maxPrice && stock.price > maxPrice) {
    return false;
  }

  if (!matchesVolatility(stock.volatility, filters.volatility)) {
    return false;
  }

  if (filters.unusualVolume && volumeRatio <= 2) {
    return false;
  }

  return true;
}

// The risk profile (low/medium/high) is a soft preference, not an explicit user filter like the
// ones above - so instead of a hard cliff (e.g. volatility 0.0301 excluded, 0.0299 included), it
// scales the stock's score continuously. A stock that doesn't match can still surface if its
// underlying strategy signal is strong enough; it just ranks lower. See docs/LOGIC_IMPROVEMENTS.md 3.5.
function applyRiskFitPenalty(stock, risk) {
  const penalty = computeRiskFitPenalty(stock, risk);
  return {
    ...stock,
    riskFitPenalty: penalty,
    score: stock.score * penalty
  };
}

function computeRiskFitPenalty(stock, risk) {
  const imputedFields = stock.imputedFields || [];
  const hasCriticalImputedData = imputedFields.includes('volatility') || imputedFields.includes('volume');
  let penalty = 1;

  if (risk === 'low') {
    const t = RISK_FIT_THRESHOLDS.low;
    penalty *= smoothCeiling(stock.volatility, t.volatilityIdeal, t.volatilityHard);
    penalty *= smoothFloor(stock.market_cap, t.marketCapIdeal, t.marketCapHard);
    if (hasCriticalImputedData) {
      penalty *= t.imputedCriticalPenalty;
    }
  } else if (risk === 'medium') {
    const t = RISK_FIT_THRESHOLDS.medium;
    penalty *= smoothCeiling(stock.volatility, t.volatilityIdeal, t.volatilityHard);
  }

  return clamp(penalty, RISK_FIT_THRESHOLDS.minPenalty, 1);
}

// 1.0 up to idealMax, tapering smoothly down to 0.2 at hardMax, instead of a hard cutoff.
function smoothCeiling(value, idealMax, hardMax) {
  if (!Number.isFinite(value) || value <= idealMax) {
    return 1;
  }
  if (value >= hardMax) {
    return 0.2;
  }
  return 1 - 0.8 * ((value - idealMax) / (hardMax - idealMax));
}

// 1.0 at/above idealMin, tapering smoothly down to 0.2 at hardMin.
function smoothFloor(value, idealMin, hardMin) {
  if (!Number.isFinite(value) || value >= idealMin) {
    return 1;
  }
  if (value <= hardMin) {
    return 0.2;
  }
  return 1 - 0.8 * ((idealMin - value) / (idealMin - hardMin));
}

function matchesMarketCap(marketCap, selected) {
  if (!selected || selected === 'any') {
    return true;
  }

  if (selected === 'large') {
    return marketCap > 10000000000;
  }

  if (selected === 'mid') {
    return marketCap >= 2000000000 && marketCap <= 10000000000;
  }

  if (selected === 'small') {
    return marketCap < 2000000000;
  }

  return true;
}

function matchesVolatility(volatility, selected) {
  if (!selected || selected === 'any') {
    return true;
  }

  if (selected === 'low') {
    return volatility < 0.025;
  }

  if (selected === 'medium') {
    return volatility >= 0.025 && volatility < 0.05;
  }

  if (selected === 'high') {
    return volatility >= 0.05;
  }

  return true;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  analyzeMarket
};

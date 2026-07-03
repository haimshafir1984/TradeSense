const { getMarketData, getStockSnapshots } = require('./marketDataService');
const { scoreStockByStrategy } = require('./strategies');
const {
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

  const [{ stocks, source }, benchmarkSnapshots] = await Promise.all([
    getMarketData(exchange),
    getStockSnapshots(MARKET_BENCHMARKS)
  ]);
  const dataQuality = assessDataQuality({ stocks, source });
  const spyBenchmark = benchmarkSnapshots.find((snapshot) => snapshot?.ticker === 'SPY');
  const marketContext = { benchmarkReturn3m: Number(spyBenchmark?.return_3m || 0) };
  const filteredStocks = stocks.filter((stock) => applyFilters(stock, filters));
  const scoreDistributions = buildStrategyScoreDistributions(filteredStocks, marketContext);
  const scoredStocks = filteredStocks
    .map((stock) => scoreStockByStrategy(strategy, stock, marketContext))
    .map((stock) => applyRiskFitPenalty(stock, risk))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);
  const validation = validateResults({ results: scoredStocks });
  const confidenceScore = computeConfidence({
    dataQuality,
    validation,
    results: scoredStocks,
    source
  });
  const marketRegime = assessMarketRegime({
    snapshots: benchmarkSnapshots,
    selectedStrategy: strategy
  });
  const adjustedConfidenceScore = computeRegimeAdjustedConfidence(confidenceScore, marketRegime);
  const results = scoredStocks.map((stock) => {
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
    returnedStocks: scoredStocks.length
  });

  return {
    results,
    meta: {
      exchange,
      strategy,
      risk,
      source,
      analyzedCount: filteredStocks.length,
      returnedCount: Math.min(scoredStocks.length, 10),
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
    penalty *= smoothCeiling(stock.volatility, 0.03, 0.07);
    penalty *= smoothFloor(stock.market_cap, 5000000000, 1000000000);
    if (hasCriticalImputedData) {
      penalty *= 0.6;
    }
  } else if (risk === 'medium') {
    penalty *= smoothCeiling(stock.volatility, 0.055, 0.09);
  }

  return clampUnit(penalty, 0.15, 1);
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

function clampUnit(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

module.exports = {
  analyzeMarket
};

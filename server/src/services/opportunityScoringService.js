const { clamp, round, average } = require('./mathUtils');

function assessOpportunity({
  stock,
  strategy,
  confidenceScore,
  riskOverlay,
  marketRegime
}) {
  // Deliberately NOT fed by confluence/expertSupport/dataQuality/marketRegime: those are all
  // derived from the same underlying indicators as stock.score and confidenceScore already, so
  // adding them again here would double-count the same signal under different names (see
  // docs/LOGIC_IMPROVEMENTS.md section 3.1). confidenceScore already reflects dataQuality and
  // regime; riskOverlay is the one genuinely distinct (downside) dimension.
  const opportunityRank = computeOpportunityRank({
    stock,
    confidenceScore,
    riskOverlay
  });
  const estimatedUpside = estimateUpside({
    stock,
    strategy,
    marketRegime,
    riskOverlay
  });
  const expectedReturnPct = round((opportunityRank / 100) * estimatedUpside.midPct, 2);
  const opportunityScore = clamp(Math.round(expectedReturnPct * 3.2), 0, 100);

  return {
    opportunityRank,
    estimatedUpside,
    expectedReturnPct,
    opportunityScore,
    recommendationLabel: buildRecommendationLabel(opportunityScore, opportunityRank, estimatedUpside.midPct)
  };
}

function summarizeOpportunity(results = []) {
  if (!results.length) {
    return {
      averageOpportunityRank: 0,
      averageExpectedReturnPct: 0,
      highestOpportunityTicker: null
    };
  }

  const avgOpportunityRank = average(results.map((result) => result.opportunity?.opportunityRank || 0));
  const avgExpectedReturnPct = average(results.map((result) => result.opportunity?.expectedReturnPct || 0));
  const highestOpportunity = [...results].sort(
    (left, right) => (right.opportunity?.opportunityScore || 0) - (left.opportunity?.opportunityScore || 0)
  )[0];

  return {
    averageOpportunityRank: round(avgOpportunityRank, 1),
    averageExpectedReturnPct: round(avgExpectedReturnPct, 2),
    highestOpportunityTicker: highestOpportunity?.ticker || null
  };
}

function computeOpportunityRank({ stock, confidenceScore, riskOverlay }) {
  let rank = 20;

  rank += Number(stock.score || 0) * 55;
  rank += Number(confidenceScore || 0) * 0.25;
  rank -= (riskOverlay?.score || 0) * 5;

  return clamp(Math.round(rank), 5, 95);
}

function estimateUpside({ stock, strategy, marketRegime, riskOverlay }) {
  let minPct = 4;
  let maxPct = 12;

  if (strategy === 'micha_stocks') {
    minPct = 6;
    maxPct = 18;
  } else if (strategy === 'mark_minervini') {
    minPct = 8;
    maxPct = 26;
  } else if (strategy === 'ross_cameron') {
    minPct = 3;
    maxPct = 14;
  } else if (strategy === 'swing_momentum') {
    minPct = 6;
    maxPct = 20;
  }

  // volumeRatio/highProximity are computed once in strategies.js#enrichStock and carried on
  // every stock through the pipeline (see indiOverlayService for the same pattern).
  const volumeRatio = stock.volumeRatio;
  const highProximity = stock.highProximity;

  if (volumeRatio >= 1.8) {
    maxPct += 4;
  }

  if (volumeRatio >= 2.5) {
    maxPct += 5;
  }

  if (highProximity >= 0.95) {
    maxPct += 3;
  } else if (highProximity <= 0.82) {
    maxPct -= 2;
  }

  if (stock.market_cap < 2000000000) {
    maxPct += 8;
  } else if (stock.market_cap < 10000000000) {
    maxPct += 4;
  }

  if (stock.volatility >= 0.055) {
    maxPct += 4;
  } else if (stock.volatility <= 0.02) {
    maxPct -= 2;
  }

  if (marketRegime?.regime === 'bullish' && strategy !== 'ross_cameron') {
    maxPct += 3;
  }

  if (marketRegime?.regime === 'volatile' && strategy === 'ross_cameron') {
    maxPct += 3;
  }

  if (marketRegime?.strategyFit?.level === 'low') {
    maxPct -= 5;
  }

  if ((riskOverlay?.score || 0) >= 4) {
    minPct = Math.max(2, minPct - 2);
  }

  minPct = clamp(Math.round(minPct), 2, 40);
  maxPct = clamp(Math.round(Math.max(maxPct, minPct + 3)), minPct + 1, 45);

  return {
    minPct,
    maxPct,
    midPct: round((minPct + maxPct) / 2, 1),
    label: `${minPct}% - ${maxPct}%`
  };
}

function buildRecommendationLabel(opportunityScore, opportunityRank, midUpside) {
  if (opportunityScore >= 70 || (opportunityRank >= 75 && midUpside >= 18)) {
    return 'הזדמנות בולטת';
  }

  if (opportunityScore >= 45 || (opportunityRank >= 65 && midUpside >= 10)) {
    return 'הזדמנות טובה';
  }

  return 'מעקב';
}

module.exports = {
  assessOpportunity,
  summarizeOpportunity
};

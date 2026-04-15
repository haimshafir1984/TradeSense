function assessOpportunity({
  stock,
  strategy,
  confidenceScore,
  dataQuality,
  confluence,
  expertSupport,
  riskOverlay,
  marketRegime
}) {
  const successProbability = computeSuccessProbability({
    stock,
    confidenceScore,
    dataQuality,
    confluence,
    expertSupport,
    riskOverlay,
    marketRegime
  });
  const estimatedUpside = estimateUpside({
    stock,
    strategy,
    marketRegime,
    riskOverlay
  });
  const expectedReturnPct = round((successProbability / 100) * estimatedUpside.midPct, 2);
  const opportunityScore = clamp(Math.round(expectedReturnPct * 3.2), 0, 100);

  return {
    successProbability,
    estimatedUpside,
    expectedReturnPct,
    opportunityScore,
    recommendationLabel: buildRecommendationLabel(opportunityScore, successProbability, estimatedUpside.midPct)
  };
}

function summarizeOpportunity(results = []) {
  if (!results.length) {
    return {
      averageSuccessProbability: 0,
      averageExpectedReturnPct: 0,
      highestOpportunityTicker: null
    };
  }

  const avgSuccessProbability = average(results.map((result) => result.opportunity?.successProbability || 0));
  const avgExpectedReturnPct = average(results.map((result) => result.opportunity?.expectedReturnPct || 0));
  const highestOpportunity = [...results].sort(
    (left, right) => (right.opportunity?.opportunityScore || 0) - (left.opportunity?.opportunityScore || 0)
  )[0];

  return {
    averageSuccessProbability: round(avgSuccessProbability, 1),
    averageExpectedReturnPct: round(avgExpectedReturnPct, 2),
    highestOpportunityTicker: highestOpportunity?.ticker || null
  };
}

function computeSuccessProbability({
  stock,
  confidenceScore,
  dataQuality,
  confluence,
  expertSupport,
  riskOverlay,
  marketRegime
}) {
  let probability = 20;

  probability += Number(stock.score || 0) * 45;
  probability += Number(confidenceScore || 0) * 0.28;
  probability += (expertSupport?.supportCount || 0) * 4;

  if (confluence?.level === 'high') {
    probability += 8;
  } else if (confluence?.level === 'medium') {
    probability += 4;
  }

  if (marketRegime?.strategyFit?.level === 'high') {
    probability += 7;
  } else if (marketRegime?.strategyFit?.level === 'low') {
    probability -= 10;
  }

  if (dataQuality?.level === 'low') {
    probability -= 12;
  } else if (dataQuality?.level === 'medium') {
    probability -= 5;
  }

  probability -= (riskOverlay?.score || 0) * 4.5;

  return clamp(Math.round(probability), 5, 95);
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
  }

  const volumeRatio = stock.volumeRatio || (stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0);
  const highProximity = stock.highProximity || (stock.high_52w ? stock.price / stock.high_52w : 0);

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

function buildRecommendationLabel(opportunityScore, successProbability, midUpside) {
  if (opportunityScore >= 70 || (successProbability >= 75 && midUpside >= 18)) {
    return 'הזדמנות בולטת';
  }

  if (opportunityScore >= 45 || (successProbability >= 65 && midUpside >= 10)) {
    return 'הזדמנות טובה';
  }

  return 'מעקב';
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return 0;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  assessOpportunity,
  summarizeOpportunity
};

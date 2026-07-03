const { scoreStockByStrategy } = require('./strategies');

const REQUIRED_FIELDS = [
  'price',
  'daily_change',
  'volume',
  'average_volume_30d',
  'market_cap',
  'high_52w',
  'low_52w',
  'MA50',
  'MA200',
  'volatility'
];

const STRATEGY_KEYS = ['micha_stocks', 'mark_minervini', 'ross_cameron'];

function assessDataQuality({ stocks = [], source = 'demo' }) {
  if (!stocks.length) {
    return {
      level: 'low',
      issues: ['לא התקבלו נתונים לניתוח'],
      missingFieldCount: 0,
      partialStockCount: 0,
      demoStockCount: 0
    };
  }

  let missingFieldCount = 0;
  let partialStockCount = 0;
  let demoStockCount = 0;
  let imputedFieldCount = 0;

  for (const stock of stocks) {
    if (stock.data_source === 'demo') {
      demoStockCount += 1;
    } else if (String(stock.data_source || '').includes('partial')) {
      partialStockCount += 1;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!Number.isFinite(Number(stock[field]))) {
        missingFieldCount += 1;
      }
    }

    imputedFieldCount += (stock.imputedFields || []).length;
  }

  const issues = [];
  let level = 'high';

  if (source === 'demo') {
    level = 'low';
    issues.push('התוצאות מבוססות על נתוני דמו');
  } else if (String(source).includes('partial')) {
    level = 'medium';
    issues.push('התוצאות מבוססות על נתונים חיים חלקיים');
  }

  if (partialStockCount > 0) {
    issues.push(`${partialStockCount} מניות השתמשו בנתונים חלקיים`);
  }

  if (demoStockCount > 0) {
    issues.push(`${demoStockCount} מניות השתמשו בנתוני דמו`);
    level = 'low';
  }

  if (missingFieldCount > 0) {
    issues.push(`נמצאו ${missingFieldCount} שדות חסרים או לא תקינים`);
    if (level === 'high') {
      level = 'medium';
    }
  }

  if (imputedFieldCount > 0) {
    issues.push(`${imputedFieldCount} שדות הושלמו אוטומטית (imputed) בהיעדר נתון חי`);
    if (level === 'high') {
      level = 'medium';
    }
  }

  return {
    level,
    issues,
    missingFieldCount,
    partialStockCount,
    demoStockCount,
    imputedFieldCount
  };
}

function validateResults({ results = [] }) {
  const warnings = [];

  if (results.length === 0) {
    warnings.push('לא נמצאו תוצאות לאחר סינון וניקוד');
  } else if (results.length < 3) {
    warnings.push('מספר התוצאות נמוך יחסית');
  }

  const scores = results
    .map((result) => Number(result.score))
    .filter((score) => Number.isFinite(score));

  const spread = computeSpread(scores);
  const averageScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;

  if (scores.length > 1 && spread < 0.12) {
    warnings.push('פיזור הציונים מצומצם');
  }

  if (scores.length > 0 && averageScore < 0.35) {
    warnings.push('רמת ההתאמה הכללית נמוכה');
  }

  if (scores.length > 0 && averageScore > 0.9) {
    warnings.push('רמת ההתאמה הכללית גבוהה מאוד ודורשת בדיקה');
  }

  return {
    status: warnings.length ? 'warning' : 'ok',
    warnings,
    stats: {
      resultCount: results.length,
      scoreSpread: round(spread),
      averageScore: round(averageScore)
    }
  };
}

function computeConfidence({ dataQuality, validation, results = [], source = 'demo' }) {
  let score = 100;

  if (dataQuality.level === 'medium') {
    score -= 18;
  } else if (dataQuality.level === 'low') {
    score -= 40;
  }

  if (source === 'demo') {
    score -= 20;
  } else if (String(source).includes('partial')) {
    score -= 10;
  }

  if (results.length < 5) {
    score -= 10;
  }

  if (results.length === 0) {
    score -= 20;
  }

  score -= Math.min(15, dataQuality.imputedFieldCount || 0);
  score -= validation.warnings.length * 6;

  return clamp(Math.round(score), 0, 100);
}

// Each strategy normalizes its score with different ranges (see strategies.js), so a raw score
// of 70 in ross_cameron is not equivalent to 70 in micha_stocks. buildStrategyScoreDistributions
// scores every stock in the currently-scanned universe under every strategy once, so confluence
// can compare each stock's *percentile within its own strategy's distribution* instead of raw
// scores against a fixed threshold. See docs/LOGIC_IMPROVEMENTS.md 3.6.
function buildStrategyScoreDistributions(stocks = [], marketContext = {}) {
  const distributions = {};

  for (const strategyKey of STRATEGY_KEYS) {
    distributions[strategyKey] = stocks
      .map((stock) => scoreStockByStrategy(strategyKey, stock, marketContext).score)
      .sort((left, right) => left - right);
  }

  return distributions;
}

function percentileRank(sortedValues, value) {
  if (!sortedValues.length) {
    return 50;
  }

  const countAtOrBelow = sortedValues.filter((entry) => entry <= value).length;
  return Math.round((countAtOrBelow / sortedValues.length) * 100);
}

function assessCrossStrategyConfluence({ stock, selectedStrategy, marketContext = {}, scoreDistributions = {} }) {
  const scoresByStrategy = {};
  const percentileByStrategy = {};

  for (const strategyKey of STRATEGY_KEYS) {
    const rawScore = scoreStockByStrategy(strategyKey, stock, marketContext).score;
    scoresByStrategy[strategyKey] = round(rawScore * 100);
    percentileByStrategy[strategyKey] = percentileRank(scoreDistributions[strategyKey] || [], rawScore);
  }

  const selectedPercentile = percentileByStrategy[selectedStrategy] || 0;
  const supportingStrategies = STRATEGY_KEYS.filter(
    (strategyKey) => strategyKey !== selectedStrategy && percentileByStrategy[strategyKey] >= 60
  );
  const strongAgreementCount = STRATEGY_KEYS.filter(
    (strategyKey) => percentileByStrategy[strategyKey] >= 70
  ).length;

  let level = 'low';
  const notes = [];

  if (selectedPercentile >= 75 && strongAgreementCount >= 2) {
    level = 'high';
    notes.push('קיימת תמיכה ממספר סגנונות מסחר');
  } else if (selectedPercentile >= 65 && supportingStrategies.length >= 1) {
    level = 'medium';
    notes.push('קיימת תמיכה חלקית מאסטרטגיה נוספת');
  } else {
    notes.push('האות חזק בעיקר בתוך האסטרטגיה שנבחרה');
  }

  if (supportingStrategies.length === 0) {
    notes.push('לא נמצאה הסכמה חזקה משיטות נוספות');
  }

  return {
    level,
    selectedStrategy,
    scoresByStrategy,
    percentileByStrategy,
    supportingStrategies,
    notes
  };
}

function assessRiskOverlay({ stock, dataQuality, strategy }) {
  const factors = [];
  let points = 0;

  if (dataQuality.level === 'low') {
    points += 2;
    factors.push('איכות הנתונים נמוכה');
  } else if (dataQuality.level === 'medium') {
    points += 1;
    factors.push('איכות הנתונים בינונית');
  }

  if (stock.volatility >= 0.055) {
    points += 2;
    factors.push('תנודתיות גבוהה');
  } else if (stock.volatility >= 0.035) {
    points += 1;
    factors.push('תנודתיות בינונית');
  }

  if (stock.market_cap < 2000000000) {
    points += 1;
    factors.push('שווי שוק קטן');
  }

  if (stock.volume < stock.average_volume_30d) {
    points += 1;
    factors.push('נפח המסחר נמוך מהממוצע');
  }

  if (stock.high_52w && stock.price / stock.high_52w >= 0.98) {
    points += 1;
    factors.push('קרובה מאוד לשיא השנתי');
  }

  if (strategy === 'ross_cameron' && stock.daily_change < 5) {
    points += 1;
    factors.push('המומנטום היומי אינו חזק במיוחד עבור אסטרטגיית מומנטום קצר טווח');
  }

  let level = 'low';

  if (points >= 4) {
    level = 'high';
  } else if (points >= 2) {
    level = 'medium';
  }

  return {
    level,
    score: points,
    factors
  };
}

function buildSummary({
  results = [],
  confidenceScore,
  dataQuality,
  validation,
  confluenceSummary,
  riskSummary,
  expertSupportSummary,
  opportunitySummary
}) {
  return {
    totalResults: results.length,
    confidenceLevel: mapConfidenceLevel(confidenceScore),
    dataIssuesPresent: dataQuality.issues.length > 0,
    validationWarningsPresent: validation.warnings.length > 0,
    highConfluenceCount: confluenceSummary?.high || 0,
    highRiskCount: riskSummary?.high || 0,
    supportedByExpertsCount: (expertSupportSummary?.strong || 0) + (expertSupportSummary?.moderate || 0),
    averageOpportunityRank: opportunitySummary?.averageOpportunityRank || 0,
    averageExpectedReturnPct: opportunitySummary?.averageExpectedReturnPct || 0,
    highestOpportunityTicker: opportunitySummary?.highestOpportunityTicker || null
  };
}

function groupResults(results = []) {
  return {
    topPicks: results.slice(0, 3).map((result) => result.ticker),
    highRisk: results
      .filter((result) => result.riskOverlay?.level === 'high')
      .map((result) => result.ticker),
    stable: results
      .filter((result) => result.riskOverlay?.level === 'low' && result.confluence?.level !== 'low')
      .map((result) => result.ticker)
  };
}

function summarizeResultLayers(results = []) {
  return results.reduce(
    (summary, result) => {
      const confluenceLevel = result.confluence?.level || 'low';
      const riskLevel = result.riskOverlay?.level || 'low';

      summary.confluence[confluenceLevel] += 1;
      summary.risk[riskLevel] += 1;

      return summary;
    },
    {
      confluence: { high: 0, medium: 0, low: 0 },
      risk: { high: 0, medium: 0, low: 0 }
    }
  );
}

function computeSpread(scores) {
  if (!scores.length) {
    return 0;
  }

  return Math.max(...scores) - Math.min(...scores);
}

function mapConfidenceLevel(score) {
  if (score >= 80) {
    return 'גבוהה';
  }

  if (score >= 55) {
    return 'בינונית';
  }

  return 'נמוכה';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  assessDataQuality,
  validateResults,
  computeConfidence,
  assessCrossStrategyConfluence,
  buildStrategyScoreDistributions,
  assessRiskOverlay,
  buildSummary,
  groupResults,
  summarizeResultLayers
};

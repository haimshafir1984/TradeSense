const { clamp, round, average } = require('./mathUtils');
const { STRATEGY_WEIGHTS } = require('../config/scoringConfig');

const STRATEGY_LABELS = {
  micha_stocks: 'השקעה לטווח ארוך - Micha Stocks',
  mark_minervini: 'מסחר לטווח קצר - Mark Minervini',
  ross_cameron: 'מומנטום קצר טווח (נתוני סוף יום) - Ross Cameron'
};

function scoreStockByStrategy(strategyKey, stock, marketContext = {}) {
  const enrichedStock = enrichStock(stock, marketContext);

  if (strategyKey === 'mark_minervini') {
    return scoreMinerviniStrategy(enrichedStock);
  }

  if (strategyKey === 'ross_cameron') {
    return scoreRossStrategy(enrichedStock);
  }

  return scoreMichaStrategy(enrichedStock);
}

function enrichStock(stock, marketContext = {}) {
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;
  const highProximity = stock.high_52w ? stock.price / stock.high_52w : 0;
  const pullbackFromHigh = stock.high_52w ? ((stock.high_52w - stock.price) / stock.high_52w) * 100 : 0;
  // Real relative strength (IBD/Minervini style): the stock's ~3-month return minus the
  // benchmark's (SPY) ~3-month return over the same window, not an internal-only composite.
  const excessReturnVsBenchmark = Number(stock.return_3m || 0) - Number(marketContext.benchmarkReturn3m || 0);
  const relativeStrength = normalize(excessReturnVsBenchmark, -8, 8);

  return {
    ...stock,
    volumeRatio,
    highProximity,
    pullbackFromHigh,
    excessReturnVsBenchmark,
    relativeStrength
  };
}

function scoreMichaStrategy(stock) {
  const trend = average([
    stock.price > stock.MA200 ? 1 : 0,
    stock.price > stock.MA50 ? 1 : 0
  ]);
  const growth = normalize(stock.market_cap, 1000000000, 60000000000);
  const pullback = scoreHighProximity(stock.pullbackFromHigh, 15);
  const volume = normalize(stock.volumeRatio, 1, 2.4);

  const w = STRATEGY_WEIGHTS.micha_stocks;
  const score = trend * w.trend + growth * w.growth + pullback * w.pullback + volume * w.volume;

  return {
    ...stock,
    score: clamp(score),
    explanation: createMichaExplanation(stock)
  };
}

function scoreMinerviniStrategy(stock) {
  const momentum = average([
    normalize(stock.daily_change, 1, 8),
    stock.relativeStrength,
    normalize(stock.ma50_slope, 0.002, 0.05)
  ]);
  // Classic Minervini trend template: price above rising MAs in order, and meaningfully off the
  // 52-week low (he uses >=25-30%) - both were fetched but never scored before.
  const aboveLow52Pct = stock.low_52w ? ((stock.price - stock.low_52w) / stock.low_52w) * 100 : 0;
  const trend = average([
    stock.price > stock.MA50 ? 1 : 0,
    stock.price > stock.MA200 ? 1 : 0,
    stock.MA50 > stock.MA200 ? 1 : 0,
    normalize(aboveLow52Pct, 20, 30)
  ]);
  const volume = normalize(stock.volumeRatio, 1, 2.5);
  // consolidation_score approximates a VCP-style tightening range ahead of breakout.
  const breakout = average([
    normalize(stock.highProximity, 0.88, 1),
    normalize(stock.relativeStrength, 0.55, 1),
    Number(stock.consolidation_score || 0)
  ]);

  const wMinervini = STRATEGY_WEIGHTS.mark_minervini;
  const score = momentum * wMinervini.momentum + trend * wMinervini.trend + volume * wMinervini.volume + breakout * wMinervini.breakout;

  return {
    ...stock,
    aboveLow52Pct: round(aboveLow52Pct, 1),
    score: clamp(score),
    explanation: createMinerviniExplanation(stock, aboveLow52Pct)
  };
}

function scoreRossStrategy(stock) {
  const momentum = normalize(stock.daily_change, 5, 12);
  const volume = normalize(stock.volumeRatio, 2, 4);
  const breakout = normalize(stock.price_near_daily_high, 0.92, 1);
  const floatScore = scoreFloatProxy(stock.market_cap);

  const wRoss = STRATEGY_WEIGHTS.ross_cameron;
  const score = momentum * wRoss.momentum + volume * wRoss.volume + breakout * wRoss.breakout + floatScore * wRoss.float;

  return {
    ...stock,
    score: clamp(score),
    explanation: createRossExplanation(stock)
  };
}

function createMichaExplanation(stock) {
  const parts = [];

  if (stock.price > stock.MA200) {
    parts.push('נמצאת במגמת עלייה מעל ממוצע 200 יום');
  }
  if (stock.pullbackFromHigh <= 15) {
    parts.push('קרובה לשיא השנתי');
  }
  if (stock.volumeRatio > 1) {
    parts.push('עם נפח מסחר גבוה מהממוצע');
  }

  return joinExplanation(parts, 'מניה יציבה עם מגמה ארוכת טווח חיובית');
}

function createMinerviniExplanation(stock, aboveLow52Pct = 0) {
  const parts = [];

  if (stock.highProximity >= 0.9) {
    parts.push('קרובה לפריצה לשיא שנתי');
  }
  if (stock.relativeStrength >= 0.65) {
    parts.push('עם חוזק יחסי גבוה');
  }
  if (stock.volumeRatio > 1) {
    parts.push('עם נפח מסחר גבוה');
  }
  if (stock.MA50 > stock.MA200) {
    parts.push('וסדר ממוצעים נכון (50 מעל 200)');
  }
  if (aboveLow52Pct >= 25) {
    parts.push('רחוקה משמעותית מהשפל השנתי');
  }
  if (Number(stock.consolidation_score || 0) >= 0.6) {
    parts.push('לאחר תקופת התכנסות (VCP)');
  }

  return joinExplanation(parts, 'מניית מומנטום עם מבנה טכני חיובי');
}

function createRossExplanation(stock) {
  const parts = [];

  if (stock.daily_change > 5) {
    parts.push('מומנטום חזק');
  }
  if (stock.volumeRatio > 2) {
    parts.push('עם נפח מסחר חריג');
  }
  if (stock.volatility >= 0.04) {
    parts.push('עם תנודתיות גבוהה');
  }

  return joinExplanation(parts, 'מניה עם מומנטום קצר טווח (מבוסס נתוני סוף יום)');
}

function joinExplanation(parts, fallback) {
  if (parts.length === 0) {
    return fallback;
  }

  return parts.join(' ');
}

function scoreHighProximity(pullbackFromHigh, maxDistance) {
  if (pullbackFromHigh > maxDistance) {
    return 0;
  }

  return clamp(1 - pullbackFromHigh / maxDistance);
}

// Approximates low-float behavior from market cap since real shares-float data isn't fetched
// (see docs/LOGIC_IMPROVEMENTS.md 3.3) - a weak proxy, most useful as a coarse tie-breaker.
function scoreFloatProxy(marketCap) {
  if (marketCap <= 0) {
    return 0;
  }

  if (marketCap <= 2000000000) {
    return 1;
  }

  if (marketCap <= 10000000000) {
    return 0.65;
  }

  return 0.25;
}

function normalize(value, min, max) {
  if (max <= min) {
    return 0;
  }

  return clamp((value - min) / (max - min));
}

module.exports = {
  STRATEGY_LABELS,
  scoreStockByStrategy
};
const { clamp, round, average } = require('./mathUtils');
const { STRATEGY_WEIGHTS, SMALL_CAP_THRESHOLDS } = require('../config/scoringConfig');

const STRATEGY_LABELS = {
  micha_stocks: 'השקעה לטווח ארוך - Micha Stocks',
  mark_minervini: 'מסחר לטווח קצר - Mark Minervini',
  ross_cameron: 'מומנטום קצר טווח (נתוני סוף יום) - Ross Cameron',
  swing_momentum: 'פריצות מומנטום (Swing)',
  small_cap_breakout: 'מניות קטנות נפיצות (Small-Cap)'
};

function scoreStockByStrategy(strategyKey, stock, marketContext = {}) {
  const enrichedStock = enrichStock(stock, marketContext);

  if (strategyKey === 'mark_minervini') {
    return scoreMinerviniStrategy(enrichedStock);
  }

  if (strategyKey === 'ross_cameron') {
    return scoreRossStrategy(enrichedStock);
  }

  if (strategyKey === 'swing_momentum') {
    return scoreSwingMomentumStrategy(enrichedStock);
  }

  if (strategyKey === 'small_cap_breakout') {
    return scoreSmallCapBreakoutStrategy(enrichedStock);
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
  // "Growth" used to just mean company size (market cap), which is a scale measure, not growth.
  // Blended with real revenue growth (YoY, from FMP/Finnhub fundamentals) so it actually reflects
  // whether the business is growing. See docs/LOGIC_IMPROVEMENTS.md 5.2.
  const revenueGrowth = normalize(stock.revenue_growth_pct, 0, 20);
  const scale = normalize(stock.market_cap, 1000000000, 60000000000);
  const growth = average([revenueGrowth, scale]);
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
  // Real shares-outstanding (enriched for Top-10 finalists only - see
  // docs/SPEC_SHORT_TERM_UPGRADE.md step 5 and shareCountService.js) replaces the market-cap-tier
  // proxy when available; falls back to the proxy otherwise so scoring is unchanged for every
  // other stock in the universe that never gets enriched.
  const realShareCountScore = scoreShareCount(stock.shareOutstanding);
  const floatScore = realShareCountScore !== null ? realShareCountScore : scoreFloatProxy(stock.market_cap);
  const floatSource = realShareCountScore !== null ? 'real' : 'proxy';

  const wRoss = STRATEGY_WEIGHTS.ross_cameron;
  const score = momentum * wRoss.momentum + volume * wRoss.volume + breakout * wRoss.breakout + floatScore * wRoss.float;

  return {
    ...stock,
    floatSource,
    score: clamp(score),
    explanation: createRossExplanation(stock)
  };
}

// Swing-momentum style (breakout / episodic-pivot), scored EOD - no real trader names, only
// generic style descriptions. Two independent sub-setups; the stock's score is whichever fits
// better, not a blend of both (see docs/LOGIC_IMPROVEMENTS.md).
function scoreSwingMomentumStrategy(stock) {
  const w = STRATEGY_WEIGHTS.swing_momentum;

  const breakoutTrend = stock.MA50 > stock.MA200 && stock.price > stock.MA50 ? 1 : 0;
  const breakoutScore =
    Number(stock.consolidation_score || 0) * w.breakout.consolidation +
    normalize(stock.highProximity, 0.85, 1) * w.breakout.highProximity +
    normalize(stock.volumeRatio, 1.5, 3) * w.breakout.volume +
    stock.relativeStrength * w.breakout.relativeStrength +
    breakoutTrend * w.breakout.trend;

  const gapSignal = Math.max(Number(stock.gap_pct || 0), Number(stock.daily_change || 0));
  const episodicPivotScore =
    normalize(gapSignal, 8, 20) * w.episodicPivot.move +
    normalize(stock.volumeRatio, 2.5, 5) * w.episodicPivot.volume;

  const isBreakoutSetup = breakoutScore >= episodicPivotScore;
  const setupScore = Math.max(breakoutScore, episodicPivotScore);

  // Core eligibility filter for this style: needs a genuinely wide daily range (ADR) and to be
  // above the long-term trend. A "dormant" stock (low ADR) is zeroed out rather than allowed to
  // rank on the other sub-factors alone.
  const eligible = Number(stock.adr_pct || 0) >= 3.5 && stock.price > stock.MA200;
  const score = eligible ? setupScore : 0;

  return {
    ...stock,
    swingSetup: isBreakoutSetup ? 'breakout' : 'episodic_pivot',
    score: clamp(score),
    explanation: createSwingMomentumExplanation(isBreakoutSetup, eligible)
  };
}

// Small-cap breakout: no real trader name, style description only. Looks for the classic
// "small stock that can move dozens of percent" profile - volume surge, sharp momentum, breaking
// toward highs, and holding up relative to the market. Gated by a hard eligibility filter (market
// cap, price, ADR) so a mega-cap or genuinely dormant stock is zeroed out rather than ranked on
// the other factors alone. adr_pct itself is deliberately NOT a scoring factor - it already gates
// eligibility, so scoring it too would double-count the same raw signal (docs/LOGIC_IMPROVEMENTS.md 3.1).
function scoreSmallCapBreakoutStrategy(stock) {
  const w = STRATEGY_WEIGHTS.small_cap_breakout;

  const volumeSurge = normalize(stock.volumeRatio, 2, 6);
  const momentumSignal = Math.max(Number(stock.gap_pct || 0), Number(stock.daily_change || 0));
  const momentum = normalize(momentumSignal, 4, 20);
  const breakout = average([normalize(stock.highProximity, 0.85, 1), Number(stock.consolidation_score || 0)]);
  const relativeStrength = stock.relativeStrength;

  const setupScore = volumeSurge * w.volumeSurge + momentum * w.momentum + breakout * w.breakout + relativeStrength * w.relativeStrength;

  const eligible =
    Number.isFinite(stock.market_cap) &&
    stock.market_cap > 0 &&
    stock.market_cap < SMALL_CAP_THRESHOLDS.marketCapCeiling &&
    stock.price >= SMALL_CAP_THRESHOLDS.minPrice &&
    Number(stock.adr_pct || 0) >= SMALL_CAP_THRESHOLDS.minAdrPct;
  const score = eligible ? setupScore : 0;

  return {
    ...stock,
    score: clamp(score),
    explanation: createSmallCapBreakoutExplanation(stock, volumeSurge, momentum, eligible)
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
  if (Number(stock.revenue_growth_pct || 0) >= 10) {
    parts.push('וצמיחת הכנסות שנתית דו-ספרתית');
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

function createSwingMomentumExplanation(isBreakoutSetup, eligible) {
  if (!eligible) {
    return 'המניה אינה עומדת בסף התנודתיות היומית (ADR) הנדרש לסגנון, או אינה נסחרת מעל ממוצע 200 יום';
  }

  if (isBreakoutSetup) {
    return 'פריצה מקונסולידציה צמודה עם נפח מסחר חריג וחוזק יחסי גבוה מעל ממוצעים עולים';
  }

  return 'גאפ על קטליזטור עם נפח מסחר חריג - פיבוט אפיזודי המצריך אימות מיידי';
}

function createSmallCapBreakoutExplanation(stock, volumeSurge, momentum, eligible) {
  if (!eligible) {
    return 'אינה עומדת בפרופיל: נדרש שווי שוק קטן מ-2 מיליארד, מחיר מעל 2$, וטווח תנודה יומי (ADR) של 5% לפחות';
  }

  if (volumeSurge >= momentum) {
    return `פריצת נפח במניה קטנה: נפח פי ${round(stock.volumeRatio, 1)} מהממוצע עם תנועה חדה`;
  }

  return 'מומנטום נפיץ: גאפ/תנועה יומית חדה בנפח חריג';
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

// Real shares-outstanding tiers (docs/SPEC_SHORT_TERM_UPGRADE.md step 5) - same shape as
// scoreFloatProxy's market-cap tiers, just fed by an actual figure when one was fetched for this
// finalist. Returns null (not 0) when there's no real data, so the caller can tell "known, large
// float" apart from "unknown" and fall back to the proxy.
function scoreShareCount(shareOutstanding) {
  if (!Number.isFinite(shareOutstanding) || shareOutstanding <= 0) {
    return null;
  }

  if (shareOutstanding <= 20000000) {
    return 1;
  }

  if (shareOutstanding <= 100000000) {
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
const MARKET_BENCHMARKS = ['SPY', 'QQQ', 'IWM'];

// A regime built from 3 ETFs on a single day is noisy; breadth across the whole scanned universe
// (already fetched for scoring, so this is free) is a much more stable read of whether the market
// is genuinely broad-based bullish/bearish/mixed. See docs/LOGIC_IMPROVEMENTS.md 3.7.
function computeMarketBreadth(universeStocks = []) {
  const validStocks = universeStocks.filter((stock) => Number.isFinite(stock?.price) && stock?.MA50 && stock?.MA200);

  if (!validStocks.length) {
    return { aboveMA50Pct: null, aboveMA200Pct: null, sampleSize: 0 };
  }

  const aboveMA50Count = validStocks.filter((stock) => stock.price > stock.MA50).length;
  const aboveMA200Count = validStocks.filter((stock) => stock.price > stock.MA200).length;

  return {
    aboveMA50Pct: round((aboveMA50Count / validStocks.length) * 100),
    aboveMA200Pct: round((aboveMA200Count / validStocks.length) * 100),
    sampleSize: validStocks.length
  };
}

function assessMarketRegime({ snapshots = [], selectedStrategy, universeStocks = [] }) {
  const validSnapshots = snapshots.filter(Boolean);

  if (!validSnapshots.length) {
    return {
      regime: 'unknown',
      label: 'לא זוהה',
      summary: 'לא התקבלו מספיק נתוני שוק רחבים כדי לזהות מצב שוק.',
      indicators: buildEmptyIndicators(),
      strategyFit: {
        level: 'medium',
        label: 'בינונית',
        note: 'אין מספיק נתונים כדי לקבוע התאמה ברורה בין מצב השוק לאסטרטגיה.'
      },
      warnings: ['מצב השוק לא זוהה']
    };
  }

  const aboveMA50Count = validSnapshots.filter((stock) => stock.price > stock.MA50).length;
  const aboveMA200Count = validSnapshots.filter((stock) => stock.price > stock.MA200).length;
  const averageDailyChange = average(validSnapshots.map((stock) => stock.daily_change));
  const averageVolatility = average(validSnapshots.map((stock) => stock.volatility));
  const breadth = computeMarketBreadth(universeStocks);

  let regime = 'sideways';
  let label = 'שוק צדדי';
  let summary = 'המדדים המובילים לא מציגים כרגע הטיה חזקה מספיק לכיוון אחד.';

  const benchmarkBullish = aboveMA200Count >= 2 && aboveMA50Count >= 2 && averageDailyChange > 0.2;
  const benchmarkBearish = aboveMA200Count <= 1 && averageDailyChange < -0.25;
  const breadthBullish = breadth.aboveMA200Pct !== null && breadth.aboveMA200Pct >= 55;
  const breadthBearish = breadth.aboveMA200Pct !== null && breadth.aboveMA200Pct <= 35;
  // A regime only counts as "volatile" when breadth is genuinely mixed, not just because 1-2 of 3
  // benchmark ETFs happened to be up today (which is true most of the time and used to make
  // "volatile" an accidental default state).
  const breadthMixed = breadth.aboveMA200Pct === null || (breadth.aboveMA200Pct > 35 && breadth.aboveMA200Pct < 65);

  if ((benchmarkBullish || breadthBullish) && !benchmarkBearish) {
    regime = 'bullish';
    label = 'שוק שורי';
    summary = 'רוב מדדי הייחוס ורוחב השוק נסחרים מעל ממוצעים מרכזיים עם תמיכה חיובית במומנטום.';
  } else if (benchmarkBearish || breadthBearish) {
    regime = 'bearish';
    label = 'שוק דובי';
    summary = 'רוחב השוק חלש יחסית והמדדים מתקשים להישאר מעל ממוצעים מרכזיים.';
  } else if (averageVolatility >= 0.04 && breadthMixed) {
    regime = 'volatile';
    label = 'שוק תנודתי';
    summary = 'קיים פיזור גבוה ותנודתיות מוגברת, ולכן האותות דורשים ניהול סיכון הדוק יותר.';
  }

  const strategyFit = assessStrategyFit(selectedStrategy, regime);
  const warnings = [];

  if (strategyFit.level === 'low') {
    warnings.push('מצב השוק פחות תומך באסטרטגיה שנבחרה');
  }

  if (regime === 'volatile') {
    warnings.push('מומלץ לעבוד עם גודל פוזיציה שמרני יותר');
  }

  return {
    regime,
    label,
    summary,
    indicators: {
      benchmarks: validSnapshots
        .filter((stock) => MARKET_BENCHMARKS.includes(stock.ticker))
        .map((stock) => ({
          ticker: stock.ticker,
          price: round(stock.price),
          dailyChange: round(stock.daily_change),
          aboveMA50: stock.price > stock.MA50,
          aboveMA200: stock.price > stock.MA200
        })),
      averageDailyChange: round(averageDailyChange),
      averageVolatility: round(averageVolatility),
      aboveMA50Count,
      aboveMA200Count,
      breadth
    },
    strategyFit,
    warnings
  };
}

function computeRegimeAdjustedConfidence(baseConfidence, marketRegime) {
  let adjusted = Number(baseConfidence || 0);

  if (marketRegime?.strategyFit?.level === 'low') {
    adjusted -= 10;
  } else if (marketRegime?.strategyFit?.level === 'medium') {
    adjusted -= 4;
  }

  if (marketRegime?.regime === 'volatile') {
    adjusted -= 4;
  }

  return Math.max(0, Math.min(100, Math.round(adjusted)));
}

// Config-driven strategy/regime fit matrix, extracted to module scope so it isn't rebuilt on
// every call and can be tuned/extended without touching assessStrategyFit's logic.
const STRATEGY_REGIME_FIT_MATRIX = {
  micha_stocks: {
    bullish: ['high', 'גבוהה', 'שוק שורי תומך יותר באסטרטגיות מגמה והשקעה ארוכת טווח.'],
    sideways: ['medium', 'בינונית', 'האותות יכולים לעבוד, אך כדאי לדרוש איכות גבוהה יותר מהמניות.'],
    volatile: ['low', 'נמוכה', 'שוק תנודתי פחות יציב עבור גישת השקעה ארוכת טווח.'],
    bearish: ['low', 'נמוכה', 'שוק דובי אינו אידאלי ללוגיקת long trend.'],
    unknown: ['medium', 'בינונית', 'אין מספיק נתונים כדי להעריך התאמה מלאה.']
  },
  mark_minervini: {
    bullish: ['high', 'גבוהה', 'שוק שורי תומך יחסית טוב באסטרטגיות מומנטום ופריצה.'],
    sideways: ['medium', 'בינונית', 'במצב צדדי כדאי להקפיד יותר על איכות פריצה ונפח.'],
    volatile: ['medium', 'בינונית', 'התנודתיות יכולה לעזור, אך הסיכוי לשבירות שווא עולה.'],
    bearish: ['low', 'נמוכה', 'שוק דובי מקשה על אסטרטגיות breakout קלאסיות.'],
    unknown: ['medium', 'בינונית', 'אין מספיק נתונים כדי להעריך התאמה מלאה.']
  },
  ross_cameron: {
    bullish: ['medium', 'בינונית', 'שוק חיובי עדיין מאפשר סטאפים למומנטום קצר טווח, אך לא בהכרח את הטובים ביותר.'],
    sideways: ['medium', 'בינונית', 'שוק צדדי דורש סלקטיביות גבוהה במומנטום קצר טווח.'],
    volatile: ['high', 'גבוהה', 'שוק תנודתי מתאים יחסית טוב לאסטרטגיות מומנטום קצר טווח.'],
    bearish: ['low', 'נמוכה', 'שוק דובי חלש עלול לפגוע באמינות של סטאפים ארוכי לונג.'],
    unknown: ['medium', 'בינונית', 'אין מספיק נתונים כדי להעריך התאמה מלאה.']
  }
};

function assessStrategyFit(strategy, regime) {
  const [level, label, note] = STRATEGY_REGIME_FIT_MATRIX[strategy]?.[regime]
    || STRATEGY_REGIME_FIT_MATRIX[strategy]?.unknown
    || ['medium', 'בינונית', 'אין מספיק נתונים.'];

  return { level, label, note };
}

function buildEmptyIndicators() {
  return {
    benchmarks: [],
    averageDailyChange: 0,
    averageVolatility: 0,
    aboveMA50Count: 0,
    aboveMA200Count: 0,
    breadth: { aboveMA50Pct: null, aboveMA200Pct: null, sampleSize: 0 }
  };
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return 0;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  MARKET_BENCHMARKS,
  assessMarketRegime,
  computeRegimeAdjustedConfidence
};

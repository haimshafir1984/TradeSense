const MARKET_BENCHMARKS = ['SPY', 'QQQ', 'IWM'];

function assessMarketRegime({ snapshots = [], selectedStrategy }) {
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
  const positiveDayCount = validSnapshots.filter((stock) => stock.daily_change > 0).length;
  const averageDailyChange = average(validSnapshots.map((stock) => stock.daily_change));
  const averageVolatility = average(validSnapshots.map((stock) => stock.volatility));

  let regime = 'sideways';
  let label = 'שוק צדדי';
  let summary = 'המדדים המובילים לא מציגים כרגע הטיה חזקה מספיק לכיוון אחד.';

  if (aboveMA200Count >= 2 && aboveMA50Count >= 2 && averageDailyChange > 0.2) {
    regime = 'bullish';
    label = 'שוק שורי';
    summary = 'רוב מדדי הייחוס נסחרים מעל ממוצעים מרכזיים עם תמיכה חיובית במומנטום.';
  } else if (aboveMA200Count <= 1 && averageDailyChange < -0.25) {
    regime = 'bearish';
    label = 'שוק דובי';
    summary = 'רוחב השוק חלש יחסית והמדדים מתקשים להישאר מעל ממוצעים מרכזיים.';
  } else if (averageVolatility >= 0.04 && positiveDayCount >= 1 && positiveDayCount <= 2) {
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
      aboveMA200Count
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

function assessStrategyFit(strategy, regime) {
  const matrix = {
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
      bullish: ['medium', 'בינונית', 'שוק חיובי עדיין מאפשר סטאפים יומיים, אך לא בהכרח את הטובים ביותר.'],
      sideways: ['medium', 'בינונית', 'שוק צדדי דורש סלקטיביות גבוהה במסחר יומי.'],
      volatile: ['high', 'גבוהה', 'שוק תנודתי מתאים יחסית טוב לאסטרטגיות מסחר יומי ממוקדות מומנטום.'],
      bearish: ['low', 'נמוכה', 'שוק דובי חלש עלול לפגוע באמינות של סטאפים ארוכי לונג.'],
      unknown: ['medium', 'בינונית', 'אין מספיק נתונים כדי להעריך התאמה מלאה.']
    }
  };

  const [level, label, note] = matrix[strategy]?.[regime] || matrix[strategy]?.unknown || ['medium', 'בינונית', 'אין מספיק נתונים.'];

  return { level, label, note };
}

function buildEmptyIndicators() {
  return {
    benchmarks: [],
    averageDailyChange: 0,
    averageVolatility: 0,
    aboveMA50Count: 0,
    aboveMA200Count: 0
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

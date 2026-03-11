const STRATEGY_LABELS = {
  micha_stocks: 'השקעה לטווח ארוך - Micha Stocks',
  mark_minervini: 'מסחר לטווח קצר - Mark Minervini',
  ross_cameron: 'מסחר יומי - Ross Cameron'
};

function scoreStockByStrategy(strategyKey, stock) {
  const enrichedStock = enrichStock(stock);

  if (strategyKey === 'mark_minervini') {
    return scoreMinerviniStrategy(enrichedStock);
  }

  if (strategyKey === 'ross_cameron') {
    return scoreRossStrategy(enrichedStock);
  }

  return scoreMichaStrategy(enrichedStock);
}

function enrichStock(stock) {
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;
  const highProximity = stock.high_52w ? stock.price / stock.high_52w : 0;
  const pullbackFromHigh = stock.high_52w ? ((stock.high_52w - stock.price) / stock.high_52w) * 100 : 0;
  const relativeStrength = average([
    normalize(stock.price / Math.max(stock.MA200 || stock.price, 1), 0.9, 1.2),
    normalize(highProximity, 0.82, 1),
    normalize(stock.daily_change, 0, 8)
  ]);

  return {
    ...stock,
    volumeRatio,
    highProximity,
    pullbackFromHigh,
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

  const score = trend * 0.35 + growth * 0.25 + pullback * 0.2 + volume * 0.2;

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
  const trend = average([
    stock.price > stock.MA50 ? 1 : 0,
    stock.price > stock.MA200 ? 1 : 0
  ]);
  const volume = normalize(stock.volumeRatio, 1, 2.5);
  const breakout = average([
    normalize(stock.highProximity, 0.88, 1),
    normalize(stock.relativeStrength, 0.55, 1)
  ]);

  const score = momentum * 0.35 + trend * 0.25 + volume * 0.25 + breakout * 0.15;

  return {
    ...stock,
    score: clamp(score),
    explanation: createMinerviniExplanation(stock)
  };
}

function scoreRossStrategy(stock) {
  const momentum = normalize(stock.daily_change, 5, 12);
  const volume = normalize(stock.volumeRatio, 2, 4);
  const breakout = normalize(stock.price_near_daily_high, 0.92, 1);
  const floatScore = scoreFloatProxy(stock.market_cap);

  const score = momentum * 0.4 + volume * 0.3 + breakout * 0.2 + floatScore * 0.1;

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

function createMinerviniExplanation(stock) {
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

  return joinExplanation(parts, 'מניה מהירה למסחר יומי');
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

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

module.exports = {
  STRATEGY_LABELS,
  scoreStockByStrategy
};
const { clamp, round, average } = require('./mathUtils');
const {
  STRATEGY_WEIGHTS,
  SMALL_CAP_THRESHOLDS,
  PULLBACK_THRESHOLDS,
  MEAN_REVERSION_THRESHOLDS
} = require('../config/scoringConfig');

const STRATEGY_LABELS = {
  micha_stocks: 'השקעה לטווח ארוך - Micha Stocks',
  mark_minervini: 'מסחר לטווח קצר - Mark Minervini',
  ross_cameron: 'מומנטום קצר טווח (נתוני סוף יום) - Ross Cameron',
  swing_momentum: 'פריצות מומנטום (Swing)',
  small_cap_breakout: 'מניות קטנות נפיצות (Small-Cap)',
  pullback_uptrend: 'קנייה בתיקון במגמת עלייה (Pullback)',
  mean_reversion_bounce: 'חזרה לממוצע אחרי נפילה חדה (Mean Reversion)'
};

// Every strategy returns, alongside its 0-1 score, a breakdown of the factors that produced it:
// what each factor scored (0-1), how much weight it carries, and what it contributed to the final
// number - plus a human-readable `detail` holding the actual observed value.
//
// This exists because a bare score plus a canned sentence doesn't answer "why is this stock here",
// which is the question the results table is supposed to answer. Sorted by contribution so the
// dominant reason is always first.
function buildBreakdown(entries) {
  return entries
    .filter((entry) => entry && Number.isFinite(entry.weight))
    .map(({ key, label, value, weight, detail }) => {
      const normalized = clamp(Number(value) || 0);
      return {
        key,
        label,
        value: round(normalized, 3),
        weight: round(weight, 3),
        contribution: round(normalized * weight, 3),
        detail: detail || null
      };
    })
    .sort((left, right) => right.contribution - left.contribution);
}

// Formatting helpers for the `detail` strings - these carry the raw observed number so the user
// sees "נפח פי 3.4 מהממוצע" rather than an opaque 0.82.
function describeMultiple(value) {
  return Number.isFinite(value) && value > 0 ? `פי ${round(value, 1)} מהממוצע` : 'אין נתון נפח';
}

function describePct(value, suffix = '') {
  return Number.isFinite(value) ? `${round(value, 1)}%${suffix}` : 'אין נתון';
}

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

  if (strategyKey === 'pullback_uptrend') {
    return scorePullbackUptrendStrategy(enrichedStock);
  }

  if (strategyKey === 'mean_reversion_bounce') {
    return scoreMeanReversionBounceStrategy(enrichedStock);
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
    explanation: createMichaExplanation(stock),
    scoreBreakdown: buildBreakdown([
      {
        key: 'trend',
        label: 'מגמה ארוכת טווח',
        value: trend,
        weight: w.trend,
        detail: `מחיר ${stock.price > stock.MA200 ? 'מעל' : 'מתחת ל'}־ממוצע 200, ${stock.price > stock.MA50 ? 'מעל' : 'מתחת ל'}־ממוצע 50`
      },
      {
        key: 'growth',
        label: 'צמיחה וגודל',
        value: growth,
        weight: w.growth,
        detail: `צמיחת הכנסות ${describePct(stock.revenue_growth_pct)}`
      },
      {
        key: 'pullback',
        label: 'קרבה לשיא השנתי',
        value: pullback,
        weight: w.pullback,
        detail: `${describePct(stock.pullbackFromHigh)} מתחת לשיא`
      },
      { key: 'volume', label: 'נפח מסחר', value: volume, weight: w.volume, detail: describeMultiple(stock.volumeRatio) }
    ])
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
    explanation: createMinerviniExplanation(stock, aboveLow52Pct),
    scoreBreakdown: buildBreakdown([
      {
        key: 'momentum',
        label: 'מומנטום',
        value: momentum,
        weight: wMinervini.momentum,
        detail: `שינוי יומי ${describePct(stock.daily_change)}, עודף מול המדד ${describePct(stock.excessReturnVsBenchmark)}`
      },
      {
        key: 'trend',
        label: 'תבנית מגמה',
        value: trend,
        weight: wMinervini.trend,
        detail: `${describePct(aboveLow52Pct)} מעל השפל השנתי, ממוצע 50 ${stock.MA50 > stock.MA200 ? 'מעל' : 'מתחת ל'}־200`
      },
      { key: 'volume', label: 'נפח מסחר', value: volume, weight: wMinervini.volume, detail: describeMultiple(stock.volumeRatio) },
      {
        key: 'breakout',
        label: 'קרבה לפריצה',
        value: breakout,
        weight: wMinervini.breakout,
        detail: `${describePct(stock.highProximity * 100)} מהשיא השנתי, התכנסות ${round(Number(stock.consolidation_score || 0), 2)}`
      }
    ])
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
    explanation: createRossExplanation(stock),
    scoreBreakdown: buildBreakdown([
      {
        key: 'momentum',
        label: 'תנועה יומית',
        value: momentum,
        weight: wRoss.momentum,
        detail: describePct(stock.daily_change, ' ביום')
      },
      { key: 'volume', label: 'נפח חריג', value: volume, weight: wRoss.volume, detail: describeMultiple(stock.volumeRatio) },
      {
        key: 'breakout',
        label: 'סגירה בשיא היום',
        value: breakout,
        weight: wRoss.breakout,
        detail: `${describePct(stock.price_near_daily_high * 100)} מהשיא היומי`
      },
      {
        key: 'float',
        label: 'כמות מניות (float)',
        value: floatScore,
        weight: wRoss.float,
        detail: floatSource === 'real' ? 'מבוסס נתון אמיתי' : 'הערכה משווי שוק בלבד'
      }
    ])
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

  // Only the winning sub-setup's factors are reported - showing both would misrepresent how the
  // score was actually produced, since the two are a max() and not a blend.
  const breakdown = isBreakoutSetup
    ? buildBreakdown([
        {
          key: 'consolidation',
          label: 'התכנסות לפני פריצה',
          value: Number(stock.consolidation_score || 0),
          weight: w.breakout.consolidation,
          detail: `ציון התכנסות ${round(Number(stock.consolidation_score || 0), 2)}`
        },
        {
          key: 'highProximity',
          label: 'קרבה לשיא השנתי',
          value: normalize(stock.highProximity, 0.85, 1),
          weight: w.breakout.highProximity,
          detail: `${describePct(stock.highProximity * 100)} מהשיא`
        },
        {
          key: 'volume',
          label: 'נפח מסחר',
          value: normalize(stock.volumeRatio, 1.5, 3),
          weight: w.breakout.volume,
          detail: describeMultiple(stock.volumeRatio)
        },
        {
          key: 'relativeStrength',
          label: 'חוזק יחסי מול השוק',
          value: stock.relativeStrength,
          weight: w.breakout.relativeStrength,
          detail: `עודף תשואה ${describePct(stock.excessReturnVsBenchmark)} מול המדד`
        },
        {
          key: 'trend',
          label: 'סדר ממוצעים',
          value: breakoutTrend,
          weight: w.breakout.trend,
          detail: breakoutTrend ? 'ממוצע 50 מעל 200 והמחיר מעליו' : 'סדר הממוצעים אינו תומך'
        }
      ])
    : buildBreakdown([
        {
          key: 'move',
          label: 'גאפ/תנועה חדה',
          value: normalize(gapSignal, 8, 20),
          weight: w.episodicPivot.move,
          detail: describePct(gapSignal, ' ביום')
        },
        {
          key: 'volume',
          label: 'נפח חריג',
          value: normalize(stock.volumeRatio, 2.5, 5),
          weight: w.episodicPivot.volume,
          detail: describeMultiple(stock.volumeRatio)
        }
      ]);

  return {
    ...stock,
    swingSetup: isBreakoutSetup ? 'breakout' : 'episodic_pivot',
    score: clamp(score),
    explanation: createSwingMomentumExplanation(isBreakoutSetup, eligible),
    eligibility: {
      passed: eligible,
      reason: eligible
        ? null
        : `נדרש ADR של 3.5% לפחות (בפועל ${describePct(stock.adr_pct)}) ומחיר מעל ממוצע 200 יום`
    },
    scoreBreakdown: breakdown
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
    explanation: createSmallCapBreakoutExplanation(stock, volumeSurge, momentum, eligible),
    eligibility: {
      passed: eligible,
      reason: eligible ? null : 'נדרש שווי שוק מתחת ל-2 מיליארד$, מחיר מעל 2$, ו-ADR של 5% לפחות'
    },
    scoreBreakdown: buildBreakdown([
      {
        key: 'volumeSurge',
        label: 'פריצת נפח',
        value: volumeSurge,
        weight: w.volumeSurge,
        detail: describeMultiple(stock.volumeRatio)
      },
      {
        key: 'momentum',
        label: 'מומנטום/גאפ',
        value: momentum,
        weight: w.momentum,
        detail: describePct(momentumSignal, ' ביום')
      },
      {
        key: 'breakout',
        label: 'קרבה לשיא והתכנסות',
        value: breakout,
        weight: w.breakout,
        detail: `${describePct(stock.highProximity * 100)} מהשיא השנתי`
      },
      {
        key: 'relativeStrength',
        label: 'חוזק יחסי מול השוק',
        value: relativeStrength,
        weight: w.relativeStrength,
        detail: `עודף תשואה ${describePct(stock.excessReturnVsBenchmark)} מול המדד`
      }
    ])
  };
}

// Pullback in an established uptrend: buy the retest, not the breakout.
//
// Structurally the opposite entry to the five strategies above, which all buy strength near highs.
// Buying a dip inside a confirmed uptrend gives a much tighter stop (just under MA50) and
// therefore a better reward/risk on the same move - the failure mode of chasing breakouts is that
// the stop has to sit far below a price that already ran. UNVALIDATED - see
// docs/SPEC_NEW_STRATEGIES.md.
function scorePullbackUptrendStrategy(stock) {
  const w = STRATEGY_WEIGHTS.pullback_uptrend;
  const t = PULLBACK_THRESHOLDS;

  // How well established the uptrend is - not just "above MA200" but the full stack in order.
  const trendQuality = average([
    stock.MA50 > stock.MA200 ? 1 : 0,
    stock.price > stock.MA200 ? 1 : 0,
    normalize(stock.ma50_slope, 0, 0.03)
  ]);

  // A tent function: peaks at the ideal depth and falls off toward "not a pullback" on one side
  // and "broken trend" on the other. A plain normalize() would wrongly reward ever-deeper drops.
  const depth = Number(stock.pullbackFromHigh || 0);
  const pullbackDepth =
    depth <= t.minDepthPct || depth >= t.maxDepthPct
      ? 0
      : depth <= t.idealDepthPct
        ? (depth - t.minDepthPct) / (t.idealDepthPct - t.minDepthPct)
        : (t.maxDepthPct - depth) / (t.maxDepthPct - t.idealDepthPct);

  // Price sitting just above MA50 is the classic support retest. Below it scores zero - that's a
  // broken pullback, not a buyable one.
  const distanceFromMa50Pct = stock.MA50 > 0 ? ((stock.price - stock.MA50) / stock.MA50) * 100 : 0;
  const maSupport = distanceFromMa50Pct < 0 ? 0 : clamp(1 - distanceFromMa50Pct / 8);

  // Healthy pullbacks happen on *falling* volume - heavy volume on a decline is distribution, not
  // a dip. This is the one factor in the whole codebase where a low volume ratio scores higher.
  const volumeDryUp = clamp(1 - normalize(stock.volumeRatio, 0.6, 1.4));

  const setupScore =
    trendQuality * w.trendQuality + pullbackDepth * w.pullbackDepth + maSupport * w.maSupport + volumeDryUp * w.volumeDryUp;

  const eligible = stock.price > stock.MA200 && stock.MA50 > stock.MA200 && depth > t.minDepthPct && depth < t.maxDepthPct;
  const score = eligible ? setupScore : 0;

  return {
    ...stock,
    score: clamp(score),
    explanation: eligible
      ? `תיקון של ${describePct(depth)} מהשיא בתוך מגמת עלייה, קרוב לתמיכת ממוצע 50`
      : 'אין כאן תיקון בתוך מגמה: נדרש מחיר מעל ממוצע 200, ממוצע 50 מעל 200, וירידה של 4%-25% מהשיא',
    eligibility: {
      passed: eligible,
      reason: eligible ? null : 'נדרשת מגמת עלייה מבוססת (מחיר מעל ממוצע 200, ממוצע 50 מעל 200) ותיקון של 4%-25% מהשיא'
    },
    scoreBreakdown: buildBreakdown([
      {
        key: 'trendQuality',
        label: 'איכות המגמה',
        value: trendQuality,
        weight: w.trendQuality,
        detail: `ממוצע 50 ${stock.MA50 > stock.MA200 ? 'מעל' : 'מתחת ל'}־200, שיפוע ${describePct(stock.ma50_slope * 100)}`
      },
      {
        key: 'pullbackDepth',
        label: 'עומק התיקון',
        value: pullbackDepth,
        weight: w.pullbackDepth,
        detail: `${describePct(depth)} מתחת לשיא (אידיאלי ~${t.idealDepthPct}%)`
      },
      {
        key: 'maSupport',
        label: 'קרבה לתמיכת ממוצע 50',
        value: maSupport,
        weight: w.maSupport,
        detail: `${describePct(distanceFromMa50Pct)} מעל ממוצע 50`
      },
      {
        key: 'volumeDryUp',
        label: 'התייבשות נפח',
        value: volumeDryUp,
        weight: w.volumeDryUp,
        detail: `${describeMultiple(stock.volumeRatio)} - נפח נמוך בתיקון הוא סימן חיובי`
      }
    ])
  };
}

// Oversold bounce: the only mean-reversion strategy in the set.
//
// Gated hard on price > MA200 on purpose. Mean reversion without a trend filter is how you buy a
// stock on its way to zero - the gate means "a stock in a long-term uptrend that just got hit",
// not "a stock that fell a lot". UNVALIDATED - see docs/SPEC_NEW_STRATEGIES.md.
function scoreMeanReversionBounceStrategy(stock) {
  const w = STRATEGY_WEIGHTS.mean_reversion_bounce;
  const t = MEAN_REVERSION_THRESHOLDS;

  const rsi = stock.rsi_14;
  const drop = stock.return_5d;
  // Both inputs are null when there wasn't enough history to compute them (see mathUtils). Scoring
  // a stock on a fabricated neutral RSI would invent a signal that was never measured.
  const measurable = Number.isFinite(rsi) && Number.isFinite(drop);

  const oversold = measurable ? clamp((t.neutralRsi - rsi) / (t.neutralRsi - t.oversoldRsi)) : 0;
  const sharpDrop = measurable ? clamp((t.minDropPct - drop) / (t.minDropPct - t.fullDropPct)) : 0;
  // Capitulation: the drop should come with heavy volume, which is what separates an exhausted
  // seller from a slow bleed.
  const volumeClimax = normalize(stock.volumeRatio, 1.2, 3);
  // How much cushion is left above the long-term trend line - the further above MA200, the more
  // room the bounce has before the trend itself is in question.
  const aboveMa200Pct = stock.MA200 > 0 ? ((stock.price - stock.MA200) / stock.MA200) * 100 : 0;
  const trendIntact = normalize(aboveMa200Pct, 0, 20);

  const setupScore =
    oversold * w.oversold + sharpDrop * w.sharpDrop + volumeClimax * w.volumeClimax + trendIntact * w.trendIntact;

  const eligible = measurable && stock.price > stock.MA200 && rsi < t.neutralRsi && drop < t.minDropPct;
  const score = eligible ? setupScore : 0;

  return {
    ...stock,
    score: clamp(score),
    explanation: eligible
      ? `נפילה של ${describePct(drop)} ב-5 ימים עם RSI ${round(rsi, 0)}, אך עדיין מעל ממוצע 200`
      : measurable
        ? 'לא מספיק מכורה: נדרש RSI מתחת ל-50, ירידה של 4%+ בחמישה ימים, ומחיר מעל ממוצע 200'
        : 'אין מספיק היסטוריית מחירים לחישוב RSI/תשואת 5 ימים',
    eligibility: {
      passed: eligible,
      reason: eligible
        ? null
        : measurable
          ? 'נדרש RSI מתחת ל-50, ירידה של 4% לפחות בחמישה ימים, ומחיר מעל ממוצע 200 יום'
          : 'חסרה היסטוריית מחירים לחישוב RSI ותשואת 5 ימים'
    },
    scoreBreakdown: buildBreakdown([
      {
        key: 'oversold',
        label: 'רמת מכירת יתר',
        value: oversold,
        weight: w.oversold,
        detail: measurable ? `RSI ${round(rsi, 0)}` : 'לא ניתן לחישוב'
      },
      {
        key: 'sharpDrop',
        label: 'חדות הנפילה',
        value: sharpDrop,
        weight: w.sharpDrop,
        detail: measurable ? `${describePct(drop)} בחמישה ימים` : 'לא ניתן לחישוב'
      },
      {
        key: 'volumeClimax',
        label: 'נפח קפיטולציה',
        value: volumeClimax,
        weight: w.volumeClimax,
        detail: describeMultiple(stock.volumeRatio)
      },
      {
        key: 'trendIntact',
        label: 'המגמה הארוכה שלמה',
        value: trendIntact,
        weight: w.trendIntact,
        detail: `${describePct(aboveMa200Pct)} מעל ממוצע 200`
      }
    ])
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
// Orchestration for anomaly mining (docs/SPEC_ANOMALY_MINING.md). Wires together the pure pieces
// (asOfFeatures, eventLabeler, patternMiner) with the data layer (universeStore, alpacaService,
// historicalBarsStore, patternStore). The mining itself (runResearch) stays CLI-only -
// server/scripts/mineAnomalies.js / matchAnomalies.js are its only callers, and it never runs
// automatically. matchSymbols() below is the one deliberate exception to the original "research →
// existing code, one-way only" rule (spec section 5.1/11): server/src/routes/anomalyMatch.js calls
// it to check specific scan-result tickers against ALREADY-MINED patterns in real time - no mining
// happens on that path, just a read of patternStore + a live bars fetch for a handful of symbols.
const universeStore = require('../universeStore');
const alpacaService = require('../providers/alpacaService');
const historicalBarsStore = require('./historicalBarsStore');
const patternStore = require('./patternStore');
const { computeFeaturesAt } = require('./asOfFeatures');
const { isEligibleRow, labelEvent, MIN_HISTORY_BARS, DEFAULT_THRESHOLD_PCT } = require('./eventLabeler');
const { discoverPatterns, evaluatePattern, passesHoldoutGate, binValue } = require('./patternMiner');

const DEFAULTS = {
  exchange: 'NASDAQ',
  historyDays: Number(process.env.RESEARCH_HISTORY_DAYS) || 680,
  measurementDays: 252,
  minMarketCap: Number(process.env.RESEARCH_MIN_MARKET_CAP) || 300000000,
  maxMarketCap: Number(process.env.RESEARCH_MAX_MARKET_CAP) || 10000000000,
  minPrice: Number(process.env.RESEARCH_MIN_PRICE) || 2,
  maxPrice: Number(process.env.RESEARCH_MAX_PRICE) || 500,
  minDollarVolume: Number(process.env.RESEARCH_MIN_DOLLAR_VOLUME) || 1000000,
  thresholdPct: Number(process.env.RESEARCH_EVENT_THRESHOLD_PCT) || DEFAULT_THRESHOLD_PCT,
  inSampleRatio: Number(process.env.RESEARCH_INSAMPLE_RATIO) || 0.667,
  maxPatterns: Number(process.env.RESEARCH_MAX_PATTERNS) || 20
};

function selectUniverseSymbols(universeRows, { minMarketCap, maxMarketCap }) {
  return universeRows
    .filter((row) => Number.isFinite(row.marketCap) && row.marketCap >= minMarketCap && row.marketCap <= maxMarketCap)
    .map((row) => ({ symbol: row.symbol, companyName: row.companyName }));
}

// Fetches bars for `symbols`, trying `feed` first with a fallback to 'iex' if it comes back empty
// (section 3 point 1 - a paid-feed entitlement failure fails soft inside alpacaService, so an empty
// Map is the only signal we get back). Uses the disk cache unless `refresh` is set.
async function getOrFetchBars({ exchange, symbols, refresh, feed, historyDays }) {
  if (!refresh) {
    const cached = await historicalBarsStore.getBars(exchange);
    if (cached && cached.bars.size > 0) {
      return cached;
    }
  }

  let barsBySymbol = await alpacaService.getDailyBars({ symbols, days: historyDays, feed });
  let usedFeed = feed;

  if (barsBySymbol.size === 0 && feed !== 'iex') {
    barsBySymbol = await alpacaService.getDailyBars({ symbols, days: historyDays, feed: 'iex' });
    usedFeed = 'iex';
  }

  await historicalBarsStore.writeBarsEntry(exchange, { feed: usedFeed, barsBySymbol });
  return { generatedAt: new Date().toISOString(), feed: usedFeed, bars: barsBySymbol };
}

// Builds eligible+labeled samples for one symbol's bar history, restricted to the last
// `measurementDays` trading days (section 2.2/2.3) - earlier bars exist only to prime lookback
// windows (MA200, 60-day high/low, etc.) inside asOfFeatures, never to be sampled themselves.
function buildSamplesForSymbol(symbol, bars, options) {
  const samples = [];
  if (!Array.isArray(bars) || bars.length < MIN_HISTORY_BARS + 1) {
    return samples;
  }

  const lastIndex = bars.length - 1;
  const measurementStart = Math.max(0, lastIndex - options.measurementDays);
  const rowOptions = { minPrice: options.minPrice, maxPrice: options.maxPrice, minDollarVolume: options.minDollarVolume };

  for (let t = measurementStart; t <= lastIndex - 1; t += 1) {
    const eligibility = isEligibleRow(bars, t, rowOptions);
    if (!eligibility.eligible) {
      continue;
    }

    const label = labelEvent(bars, t, { thresholdPct: options.thresholdPct });
    if (!label.labeled) {
      continue;
    }

    const features = computeFeaturesAt(bars, t);
    samples.push({ symbol, date: bars[t].t, features, isEvent: label.isEvent });
  }

  return samples;
}

// Chronological in-sample/holdout split (section 6.1) - by unique DATE across the whole universe
// (not by row count), since many symbols share the same trading calendar and the point is to train
// on an earlier block of time and validate on a later, non-overlapping block.
function chronologicalSplit(rows, inSampleRatio) {
  const uniqueDates = [...new Set(rows.map((row) => row.date))].sort();
  const splitCount = Math.max(1, Math.floor(uniqueDates.length * inSampleRatio));
  const cutoffDate = uniqueDates[splitCount - 1];

  return {
    inSampleRows: rows.filter((row) => row.date <= cutoffDate),
    holdoutRows: rows.filter((row) => row.date > cutoffDate),
    cutoffDate,
    uniqueDateCount: uniqueDates.length
  };
}

function baseRateOf(rows) {
  if (!rows.length) return 0;
  return rows.filter((row) => row.isEvent).length / rows.length;
}

// Which universe symbols satisfy each pattern's conditions, using the most recent closed trading
// day available in `barsBySymbol` and the SAME boundaries the pattern was discovered/stored with
// (never recomputed here - see patternMiner.js section header for why that matters).
function matchLatest(patterns, boundaries, barsBySymbol) {
  return patterns.map((pattern) => {
    const matchingSymbols = [];

    for (const [symbol, bars] of barsBySymbol) {
      if (!Array.isArray(bars) || bars.length < MIN_HISTORY_BARS) {
        continue;
      }
      const lastIndex = bars.length - 1;
      const features = computeFeaturesAt(bars, lastIndex);

      const satisfiesAll = pattern.conditions.every((condition) => {
        const value = features[condition.feature];
        return Number.isFinite(value) && binValue(condition.feature, value, boundaries[condition.feature]) === condition.bin;
      });

      if (satisfiesAll) {
        matchingSymbols.push({ symbol, date: bars[lastIndex].t, features });
      }
    }

    return { pattern, matchingSymbols };
  });
}

async function runResearch(rawOptions = {}) {
  const options = { ...DEFAULTS, ...rawOptions };

  if (!alpacaService.isConfigured()) {
    throw new Error(
      'ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY are not set - anomaly mining needs Alpaca bars and cannot fall back to demo data (docs/SPEC_ANOMALY_MINING.md section 9.7).'
    );
  }

  const universe = await universeStore.getUniverse(options.exchange);
  if (!universe || !universe.rows.length) {
    throw new Error(`No usable universe for ${options.exchange} in universeStore - run the app once so the nightly universe builder populates it.`);
  }

  const candidates = selectUniverseSymbols(universe.rows, options);
  if (!candidates.length) {
    throw new Error(`No symbols in ${options.exchange} universe fall within market cap range [${options.minMarketCap}, ${options.maxMarketCap}].`);
  }

  const symbols = candidates.map((c) => c.symbol);
  const { bars: barsBySymbol, feed } = await getOrFetchBars({
    exchange: options.exchange,
    symbols,
    refresh: options.refreshBars,
    feed: options.feed || 'delayed_sip',
    historyDays: options.historyDays
  });

  const allSamples = [];
  const symbolsWithData = [];
  for (const { symbol } of candidates) {
    const bars = barsBySymbol.get(symbol);
    if (!bars) continue;
    symbolsWithData.push(symbol);
    allSamples.push(...buildSamplesForSymbol(symbol, bars, options));
  }

  const { inSampleRows, holdoutRows, cutoffDate, uniqueDateCount } = chronologicalSplit(allSamples, options.inSampleRatio);
  const baseRateInSample = baseRateOf(inSampleRows);
  const baseRateHoldout = baseRateOf(holdoutRows);

  const discovery = discoverPatterns(inSampleRows, { maxPatterns: options.maxPatterns });

  const survived = [];
  const rejectedAtHoldout = [];
  for (const pattern of discovery.patterns) {
    const holdoutEval = evaluatePattern(holdoutRows, pattern, discovery.boundaries, baseRateHoldout);
    const entry = {
      ...pattern,
      inSample: { n: pattern.n, hits: pattern.hits, p: pattern.p, lift: pattern.lift, wilsonLB: pattern.wilsonLB },
      holdout: holdoutEval
    };
    if (passesHoldoutGate(holdoutEval, baseRateHoldout)) {
      survived.push(entry);
    } else {
      rejectedAtHoldout.push(entry);
    }
  }

  const matches = matchLatest(survived, discovery.boundaries, barsBySymbol);

  return {
    exchange: options.exchange,
    generatedAt: new Date().toISOString(),
    feed,
    thresholdPct: options.thresholdPct,
    universeParams: { minMarketCap: options.minMarketCap, maxMarketCap: options.maxMarketCap },
    rowFilters: { minPrice: options.minPrice, maxPrice: options.maxPrice, minDollarVolume: options.minDollarVolume },
    symbolCountConsidered: candidates.length,
    symbolCountWithData: symbolsWithData.length,
    totalSamples: allSamples.length,
    uniqueDateCount,
    cutoffDate,
    baseRateInSample,
    baseRateHoldout,
    inSampleCount: inSampleRows.length,
    holdoutCount: holdoutRows.length,
    boundaries: discovery.boundaries,
    survived,
    rejectedAtHoldout,
    matches
  };
}

async function persistPatterns(researchResult) {
  await patternStore.writePatterns({
    generatedAt: researchResult.generatedAt,
    exchange: researchResult.exchange,
    feed: researchResult.feed,
    thresholdPct: researchResult.thresholdPct,
    universeParams: researchResult.universeParams,
    rowFilters: researchResult.rowFilters,
    boundaries: researchResult.boundaries,
    patterns: researchResult.survived
  });
}

async function runMatch(rawOptions = {}) {
  const options = { ...DEFAULTS, ...rawOptions };
  const stored = await patternStore.readPatterns();

  if (!stored || !Array.isArray(stored.patterns) || !stored.patterns.length) {
    return { patterns: [], message: 'No saved patterns to match against - run mineAnomalies first.' };
  }

  if (!alpacaService.isConfigured()) {
    throw new Error("ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY are not set - matching needs bars to compute today's features.");
  }

  const universe = await universeStore.getUniverse(stored.exchange);
  const candidates = universe ? selectUniverseSymbols(universe.rows, stored.universeParams) : [];
  const symbols = candidates.map((c) => c.symbol);

  const { bars: barsBySymbol } = await getOrFetchBars({
    exchange: stored.exchange,
    symbols,
    refresh: options.refreshBars,
    feed: stored.feed || 'iex',
    historyDays: options.historyDays
  });

  const matches = matchLatest(stored.patterns, stored.boundaries, barsBySymbol);
  return { patterns: matches, generatedAt: stored.generatedAt, exchange: stored.exchange };
}

// Feature flag for the live scan-result matching integration - same pattern as
// vibeTradingService.isEnabled (server/src/services/vibeTradingService.js): strict string equality,
// off by default.
function isEnabled() {
  return process.env.ANOMALY_MATCH_ENABLED === 'true';
}

// Checks a specific, caller-supplied list of tickers (the current scan's results - typically <=10)
// against whatever patterns are currently saved in patternStore. Deliberately does NOT go through
// universeStore/selectUniverseSymbols - the caller already knows exactly which symbols it wants
// checked, so this stays a single batched bars fetch for just those symbols, independent of the
// mining universe's market-cap band (a result outside that band can still be checked; the report's
// caveat about the validated range still applies, but nothing here silently drops it).
async function matchSymbols(tickers) {
  const stored = await patternStore.readPatterns();
  if (!stored || !Array.isArray(stored.patterns) || !stored.patterns.length) {
    return { available: false, message: 'No saved anomaly patterns yet - run research:mine first.' };
  }

  if (!alpacaService.isConfigured()) {
    return { available: false, message: 'Alpaca is not configured - anomaly matching needs bars to compute current features.' };
  }

  const barsBySymbol = await alpacaService.getDailyBars({ symbols: tickers, days: DEFAULTS.historyDays, feed: stored.feed || 'iex' });
  const matchesByPattern = matchLatest(stored.patterns, stored.boundaries, barsBySymbol);

  // Reshape pattern-major (matchLatest's natural output) to symbol-major, which is what the client
  // needs to look up "does THIS row's ticker match anything" cheaply per table row.
  const results = {};
  for (const ticker of tickers) {
    results[ticker] = { matches: [] };
  }
  for (const { pattern, matchingSymbols } of matchesByPattern) {
    for (const match of matchingSymbols) {
      if (results[match.symbol]) {
        results[match.symbol].matches.push({
          label: pattern.label,
          holdout: { n: pattern.holdout.n, p: pattern.holdout.p, lift: pattern.holdout.lift }
        });
      }
    }
  }

  return {
    available: true,
    generatedAt: stored.generatedAt,
    universeParams: stored.universeParams,
    results
  };
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function patternTableRow(entry) {
  const holdout = entry.holdout;
  return `| ${entry.label} | ${entry.n} | ${entry.hits} | ${pct(entry.p)} | ${entry.lift.toFixed(2)} | ${entry.wilsonLB.toFixed(3)} | ${holdout.n} | ${holdout.hits} | ${pct(holdout.p)} | ${holdout.lift.toFixed(2)} | ${holdout.wilsonLB.toFixed(3)} | ${entry.uniqueSymbols} |`;
}

// Renders the human-readable findings report (section 7.2). Pure function of runResearch's output
// - server/scripts/mineAnomalies.js is the only thing that writes this to docs/ANOMALY_FINDINGS.md.
// The limitations section is fixed content, not conditional on the run's results - see the spec's
// explicit instruction that it must never be trimmed or removed.
function renderReport(result) {
  const lines = [];
  lines.push('# ממצאי כריית אנומליות — TradeSense');
  lines.push('');
  lines.push(`תאריך ריצה: ${result.generatedAt}`);
  lines.push(`מקור: \`docs/SPEC_ANOMALY_MINING.md\` (נוצר אוטומטית ע"י \`node scripts/mineAnomalies.js\` — נדרס בכל ריצה)`);
  lines.push('');
  lines.push('**זו אינה המלצת השקעה. עבר אינו מבטיח עתיד. ראו סעיף מגבלות בתחתית המסמך לפני הסקת מסקנות.**');
  lines.push('');

  lines.push('## 1. פרמטרי הריצה');
  lines.push('');
  lines.push(`- בורסה: ${result.exchange}`);
  lines.push(`- סף אירוע: ${result.thresholdPct}% ביום בודד (close-to-close)`);
  lines.push(`- טווח שווי שוק: ${result.universeParams.minMarketCap.toLocaleString()} - ${result.universeParams.maxMarketCap.toLocaleString()}`);
  lines.push(`- מחיר: ${result.rowFilters.minPrice}-${result.rowFilters.maxPrice}$, נפח דולרי חציוני מינימלי: ${result.rowFilters.minDollarVolume.toLocaleString()}$`);
  lines.push(`- מקור הנפח (feed): \`${result.feed}\`${result.feed === 'iex' ? ' (כיסוי חלקי של נפח השוק - ראו מגבלות)' : ''}`);
  lines.push(`- סימולים בטווח שווי השוק: ${result.symbolCountConsidered} (נתונים התקבלו ל-${result.symbolCountWithData})`);
  lines.push(`- סה"כ stock-days כשירים: ${result.totalSamples}`);
  lines.push(`- ימי מסחר ייחודיים בחלון המדידה: ${result.uniqueDateCount} (חיתוך in-sample/holdout בתאריך ${result.cutoffDate})`);
  lines.push(`- in-sample: ${result.inSampleCount} שורות | holdout: ${result.holdoutCount} שורות`);
  lines.push('');

  lines.push('## 2. Base rate');
  lines.push('');
  lines.push(`- in-sample: ${pct(result.baseRateInSample)} (מתוך ${result.inSampleCount} שורות)`);
  lines.push(`- holdout: ${pct(result.baseRateHoldout)} (מתוך ${result.holdoutCount} שורות)`);
  lines.push('');

  const tableHeader =
    '| תבנית | n (in-sample) | hits | p | lift | wilsonLB | n (holdout) | hits | p | lift | wilsonLB | סימולים ייחודיים |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|';

  lines.push('## 3. תבניות ששרדו את שער ה-holdout');
  lines.push('');
  if (result.survived.length === 0) {
    lines.push('**לא נמצאה אף תבנית שעברה את שער האימות בריצה זו.** זו תוצאה לגיטימית - ראו סעיף 0.4/6.5 במסמך האיפיון.');
  } else {
    lines.push(tableHeader);
    for (const entry of result.survived) {
      lines.push(patternTableRow(entry));
    }
  }
  lines.push('');

  lines.push('## 4. תבניות שנפלו בשער ה-holdout');
  lines.push('');
  lines.push('חובה להציג את הטבלה הזו — היא העדות המרכזית על מידת ה-overfitting בשלב הגילוי.');
  lines.push('');
  if (result.rejectedAtHoldout.length === 0) {
    lines.push('(אין - כל התבניות שעברו את שלב הגילוי גם שרדו את ה-holdout, או שלא נמצאה אף תבנית בשלב הגילוי.)');
  } else {
    lines.push(tableHeader);
    for (const entry of result.rejectedAtHoldout) {
      lines.push(patternTableRow(entry));
    }
  }
  lines.push('');

  if (result.survived.length > 0) {
    lines.push('## 5. הצלבה מול היום — מי עומד בקריטריון כעת');
    lines.push('');
    lines.push('רשימת סימולים בלבד, ללא דירוג וללא ציון "מומלץ ביותר" — ראו סעיף 0.4 במסמך האיפיון.');
    lines.push('');
    for (const match of result.matches) {
      lines.push(`**${match.pattern.label}** (holdout: ${pct(match.pattern.holdout.p)} על ${match.pattern.holdout.n} מופעים, lift ${match.pattern.holdout.lift.toFixed(2)})`);
      if (match.matchingSymbols.length === 0) {
        lines.push('- אין היום אף סימול שעומד בקריטריון הזה.');
      } else {
        for (const m of match.matchingSymbols) {
          lines.push(`- ${m.symbol}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## 6. מגבלות (לקרוא לפני הסקת מסקנות)');
  lines.push('');
  lines.push(
    `- **נפח מ-feed=${result.feed}.** ${result.feed === 'iex' ? 'הנפח בברים הוא נפח IEX בלבד (כ-2-3% מהנפח המאוחד), לא נפח השוק המלא. מכיוון שהסיגנל המרכזי הנבדק כאן הוא לרוב אנומליית נפח, זו המגבלה החמורה ביותר בדוח הזה.' : 'נעשה שימוש ב-delayed SIP, קרוב יותר לנפח האמיתי של השוק מ-IEX, אך עדיין לא feed בזמן אמת.'}`
  );
  lines.push(
    '- **הטיית שרידות (survivorship bias).** רשימת הסימולים מבוססת נכסים פעילים בלבד כיום - מניה שקפצה ואז נמחקה מהמסחר אינה חלק מהמדגם.'
  );
  lines.push(
    '- **הטיית שווי שוק לא-point-in-time.** סינון הטווח (300M-10B) מבוסס שווי השוק של היום, לא של בזמן המדידה - מניה שהייתה קטנה יותר וקפצה נראית "בטווח" גם אם לא הייתה כזו בזמן האמת.'
  );
  lines.push('- **הדרת הנפקות טריות.** נדרשים לפחות 210 ברים לפני כל שורה - מניות IPO טריות אינן חלק מהמדגם.');
  lines.push('- **תצפיות לא בלתי-תלויות (clustering).** מספר "hits" של תבנית יכול להתרכז בכמה סימולים/ימים קרובים - מטופל חלקית ע"י מסנני הריכוזיות בשלב הגילוי (סעיף 6.4), אך לא מתוקן סטטיסטית באופן מלא.');
  lines.push('- **עבר אינו מבטיח עתיד. זו אינה המלצת השקעה, לא דירוג מניות, ולא ציון הסתברות מכויל.**');
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  DEFAULTS,
  selectUniverseSymbols,
  buildSamplesForSymbol,
  chronologicalSplit,
  baseRateOf,
  matchLatest,
  renderReport,
  runResearch,
  persistPatterns,
  runMatch,
  isEnabled,
  matchSymbols
};

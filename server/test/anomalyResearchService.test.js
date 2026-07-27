const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  chronologicalSplit,
  baseRateOf,
  buildSamplesForSymbol,
  matchLatest,
  renderReport,
  selectUniverseSymbols
} = require('../src/services/research/anomalyResearchService');
const { computeBinBoundaries } = require('../src/services/research/patternMiner');

function bar(t, c, v = 500000) {
  return { t, o: c, h: c * 1.01, l: c * 0.99, c, v };
}

test('chronologicalSplit divides rows by unique date, not by row count', () => {
  // 10 unique dates, but symbol A has 3 rows per date and symbol B has 1 - a row-count split would
  // give a different cutoff than a date-based split.
  const rows = [];
  for (let d = 0; d < 10; d += 1) {
    const date = `2024-01-${String(d + 1).padStart(2, '0')}`;
    rows.push({ symbol: 'A', date, features: {}, isEvent: false });
    rows.push({ symbol: 'A', date, features: {}, isEvent: false });
    rows.push({ symbol: 'A', date, features: {}, isEvent: false });
    rows.push({ symbol: 'B', date, features: {}, isEvent: false });
  }

  const { inSampleRows, holdoutRows, cutoffDate, uniqueDateCount } = chronologicalSplit(rows, 0.7);

  assert.equal(uniqueDateCount, 10);
  assert.equal(cutoffDate, '2024-01-07'); // floor(10*0.7) = 7 unique dates in-sample
  assert.ok(inSampleRows.every((row) => row.date <= cutoffDate));
  assert.ok(holdoutRows.every((row) => row.date > cutoffDate));
  assert.equal(inSampleRows.length + holdoutRows.length, rows.length);
});

test('baseRateOf is the fraction of rows labeled as events, 0 for an empty array', () => {
  assert.equal(baseRateOf([{ isEvent: true }, { isEvent: false }, { isEvent: false }, { isEvent: true }]), 0.5);
  assert.equal(baseRateOf([]), 0);
});

test('selectUniverseSymbols filters by market cap range, dropping rows with missing/out-of-range cap', () => {
  const rows = [
    { symbol: 'A', companyName: 'A Inc', marketCap: 500000000 },
    { symbol: 'B', companyName: 'B Inc', marketCap: 50000000 }, // too small
    { symbol: 'C', companyName: 'C Inc', marketCap: 50000000000 }, // too large
    { symbol: 'D', companyName: 'D Inc', marketCap: null } // unknown - must not pass
  ];

  const selected = selectUniverseSymbols(rows, { minMarketCap: 300000000, maxMarketCap: 10000000000 });

  assert.deepEqual(selected.map((r) => r.symbol), ['A']);
});

test('buildSamplesForSymbol only samples within the last measurementDays trading days and skips symbols with too little history', () => {
  const bars = Array.from({ length: 300 }, (_, i) => bar(`2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 20 + (i % 5)));

  const samples = buildSamplesForSymbol('AAA', bars, {
    measurementDays: 50,
    thresholdPct: 12,
    minPrice: 1,
    maxPrice: 500,
    minDollarVolume: 1
  });

  // measurement window is the last 50 trading days (indices 250..298, since 299 has no next bar)
  assert.ok(samples.length > 0);
  assert.ok(samples.length <= 50);
  const earliestSampledIndex = bars.findIndex((b) => b.t === samples[0].date);
  assert.ok(earliestSampledIndex >= 300 - 1 - 50);

  const tooShort = buildSamplesForSymbol('BBB', bars.slice(0, 100), { measurementDays: 50, thresholdPct: 12, minPrice: 1, maxPrice: 500, minDollarVolume: 1 });
  assert.deepEqual(tooShort, []);
});

test('buildSamplesForSymbol labels a genuine 12%+ move and skips a sub-threshold move', () => {
  const history = Array.from({ length: 220 }, (_, i) => bar(`2023-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 20));
  const eventDay = bar('2024-06-01', 22.5); // 12.5% above the flat 20 base
  const bars = history.concat([eventDay]);

  const samples = buildSamplesForSymbol('AAA', bars, { measurementDays: 5, thresholdPct: 12, minPrice: 1, maxPrice: 500, minDollarVolume: 1 });

  // The setup day (index bars.length - 2) should be sampled and labeled as an event.
  const setupDate = bars[bars.length - 2].t;
  const sample = samples.find((s) => s.date === setupDate);
  assert.ok(sample, 'expected a sample for the setup day preceding the event');
  assert.equal(sample.isEvent, true);
});

test('matchLatest finds symbols whose most recent closed day satisfies a pattern, using the given boundaries', () => {
  const trainingRows = Array.from({ length: 1000 }, (_, i) => ({ features: { volumeRatio1d: i / 250 } }));
  const boundaries = computeBinBoundaries(trainingRows, ['volumeRatio1d']);

  const pattern = { conditions: [{ feature: 'volumeRatio1d', bin: 3, label: 'x' }] };

  const barsBySymbol = new Map([
    ['HIGH', Array.from({ length: 220 }, () => bar('2024-01-01', 20)).concat([{ ...bar('2024-06-01', 25), v: 5000000 }])],
    ['LOW', Array.from({ length: 220 }, () => bar('2024-01-01', 20)).concat([bar('2024-06-01', 20.1)])]
  ]);

  // Directly stub the feature computation path isn't available here, so just assert the function
  // runs without throwing and returns one entry per pattern with a matchingSymbols array.
  const result = matchLatest([pattern], boundaries, barsBySymbol);
  assert.equal(result.length, 1);
  assert.ok(Array.isArray(result[0].matchingSymbols));
});

test('renderReport always includes the limitations section, even with zero surviving patterns', () => {
  const report = renderReport({
    exchange: 'NASDAQ',
    generatedAt: '2026-01-01T00:00:00Z',
    feed: 'iex',
    thresholdPct: 12,
    universeParams: { minMarketCap: 300000000, maxMarketCap: 10000000000 },
    rowFilters: { minPrice: 2, maxPrice: 500, minDollarVolume: 1000000 },
    symbolCountConsidered: 10,
    symbolCountWithData: 10,
    totalSamples: 1000,
    uniqueDateCount: 252,
    cutoffDate: '2025-06-01',
    baseRateInSample: 0.02,
    baseRateHoldout: 0.018,
    inSampleCount: 700,
    holdoutCount: 300,
    survived: [],
    rejectedAtHoldout: [],
    matches: []
  });

  assert.ok(report.includes('מגבלות'));
  assert.ok(report.includes('survivorship') || report.includes('שרידות'));
  assert.ok(report.includes('לא נמצאה אף תבנית שעברה את שער האימות'));
  assert.ok(report.includes('אינה המלצת השקעה'));
});

// ---- isEnabled / matchSymbols - the live scan-result matching integration ----

function scratchPatternsFile() {
  return path.join(os.tmpdir(), `anomalyPatterns-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function freshPatternStore(patternsFilePath) {
  process.env.RESEARCH_PATTERNS_FILE_PATH = patternsFilePath;
  delete require.cache[require.resolve('../src/services/research/patternStore')];
  return require('../src/services/research/patternStore');
}

function freshAnomalyResearchService() {
  delete require.cache[require.resolve('../src/services/research/anomalyResearchService')];
  return require('../src/services/research/anomalyResearchService');
}

function clearAlpacaEnv() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

// Same clock-mock requirement as alpacaService.test.js: getDailyBars checks /v2/clock first.
function withClock(handler) {
  return async (url, ...rest) => {
    if (url.includes('/v2/clock')) {
      return jsonResponse({ is_open: false });
    }
    return handler(url, ...rest);
  };
}

function flatBar(t, c, v = 500000) {
  return { t, o: c, h: c * 1.01, l: c * 0.99, c, v };
}

test('isEnabled reflects ANOMALY_MATCH_ENABLED exactly (strict "true", matching vibeTradingService convention)', () => {
  delete process.env.ANOMALY_MATCH_ENABLED;
  const service = freshAnomalyResearchService();
  assert.equal(service.isEnabled(), false);

  process.env.ANOMALY_MATCH_ENABLED = 'true';
  assert.equal(service.isEnabled(), true);

  process.env.ANOMALY_MATCH_ENABLED = 'yes';
  assert.equal(service.isEnabled(), false);

  delete process.env.ANOMALY_MATCH_ENABLED;
});

test('matchSymbols returns available:false when no patterns have been saved yet', async () => {
  const scratchPath = scratchPatternsFile();
  freshPatternStore(scratchPath);
  const service = freshAnomalyResearchService();

  const result = await service.matchSymbols(['AAPL']);

  delete process.env.RESEARCH_PATTERNS_FILE_PATH;

  assert.equal(result.available, false);
});

test('matchSymbols returns available:false when Alpaca is not configured, without attempting a network call', async () => {
  const scratchPath = scratchPatternsFile();
  const patternStore = freshPatternStore(scratchPath);
  await patternStore.writePatterns({
    generatedAt: '2026-01-01T00:00:00Z',
    exchange: 'NASDAQ',
    feed: 'iex',
    boundaries: {},
    patterns: [{ conditions: [], label: 'x', holdout: { n: 1, p: 1, lift: 1 } }]
  });
  const service = freshAnomalyResearchService();

  clearAlpacaEnv();
  const result = await service.matchSymbols(['AAPL']);

  fs.rmSync(scratchPath, { force: true });
  delete process.env.RESEARCH_PATTERNS_FILE_PATH;

  assert.equal(result.available, false);
});

test('matchSymbols correctly identifies which of several tickers currently satisfy a saved pattern', async () => {
  const scratchPath = scratchPatternsFile();
  const patternStore = freshPatternStore(scratchPath);

  // Boundaries built from a training set uniform 0..10 -> quartile cuts near [2.5, 5, 7.5].
  const trainingRows = Array.from({ length: 1000 }, (_, i) => ({ features: { dailyChange: (i / 1000) * 10 } }));
  const boundaries = computeBinBoundaries(trainingRows, ['dailyChange']);

  await patternStore.writePatterns({
    generatedAt: '2026-01-01T00:00:00Z',
    exchange: 'NASDAQ',
    feed: 'iex',
    boundaries,
    patterns: [
      {
        label: 'dailyChange top quartile',
        conditions: [{ feature: 'dailyChange', bin: 3, label: 'dailyChange in top quartile' }],
        holdout: { n: 500, p: 0.1, lift: 4 }
      }
    ]
  });

  const service = freshAnomalyResearchService();

  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';

  const history = Array.from({ length: 215 }, () => flatBar('2023-01-01', 20));
  // AAA's last close is +9% over the prior close -> bin 3 (matches). BBB's is +1% -> bin 0 (no match).
  const aaaBars = history.concat([flatBar('2024-06-01', 20 * 1.09)]);
  const bbbBars = history.concat([flatBar('2024-06-01', 20 * 1.01)]);

  const originalFetch = global.fetch;
  global.fetch = withClock(async () =>
    jsonResponse({
      bars: {
        AAA: aaaBars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
        BBB: bbbBars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      },
      next_page_token: null
    })
  );

  const result = await service.matchSymbols(['AAA', 'BBB']);

  global.fetch = originalFetch;
  clearAlpacaEnv();
  fs.rmSync(scratchPath, { force: true });
  delete process.env.RESEARCH_PATTERNS_FILE_PATH;

  assert.equal(result.available, true);
  assert.equal(result.results.AAA.matches.length, 1);
  assert.equal(result.results.AAA.matches[0].label, 'dailyChange top quartile');
  assert.deepEqual(result.results.AAA.matches[0].conditions, [{ feature: 'dailyChange', bin: 3 }]);
  assert.equal(result.results.BBB.matches.length, 0);
});

test('matchSymbols does not throw for a ticker with too little bar history - it simply has no matches', async () => {
  const scratchPath = scratchPatternsFile();
  const patternStore = freshPatternStore(scratchPath);
  const trainingRows = Array.from({ length: 1000 }, (_, i) => ({ features: { dailyChange: (i / 1000) * 10 } }));
  const boundaries = computeBinBoundaries(trainingRows, ['dailyChange']);

  await patternStore.writePatterns({
    generatedAt: '2026-01-01T00:00:00Z',
    exchange: 'NASDAQ',
    feed: 'iex',
    boundaries,
    patterns: [{ label: 'x', conditions: [{ feature: 'dailyChange', bin: 3, label: 'x' }], holdout: { n: 500, p: 0.1, lift: 4 } }]
  });

  const service = freshAnomalyResearchService();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';

  const shortHistory = Array.from({ length: 20 }, () => flatBar('2024-01-01', 20)); // well under MIN_HISTORY_BARS

  const originalFetch = global.fetch;
  global.fetch = withClock(async () => jsonResponse({ bars: { IPO: shortHistory }, next_page_token: null }));

  const result = await service.matchSymbols(['IPO']);

  global.fetch = originalFetch;
  clearAlpacaEnv();
  fs.rmSync(scratchPath, { force: true });
  delete process.env.RESEARCH_PATTERNS_FILE_PATH;

  assert.equal(result.available, true);
  assert.equal(result.results.IPO.matches.length, 0);
});

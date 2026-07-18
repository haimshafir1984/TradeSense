const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMarket } = require('../src/services/scannerService');

test('analyzeMarket runs end-to-end on demo data without institutional/insider filters', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {}
  });

  assert.ok(Array.isArray(response.results));
  assert.ok(response.results.length > 0);
  for (const result of response.results) {
    assert.equal(result.institutional_inflow, undefined);
    assert.equal(result.insider_transactions, undefined);
  }
});

test('applyFilters no longer recognizes institutionalBuying/insiderBuying flags', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const withFlags = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: { institutionalBuying: true, insiderBuying: true }
  });
  const withoutFlags = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {}
  });

  assert.equal(withFlags.meta.analyzedCount, withoutFlags.meta.analyzedCount);
});

test('wideScan:true uses the wide-scan universe for an eligible strategy when it succeeds', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const wideScanUniverseService = require('../src/services/wideScanUniverseService');
  const originalScanWideUniverse = wideScanUniverseService.scanWideUniverse;
  wideScanUniverseService.scanWideUniverse = async () => [
    {
      ticker: 'WIDE1',
      companyName: 'Wide One Inc',
      sector: 'Unknown',
      exchange: 'NASDAQ',
      price: 20,
      daily_change: 3,
      gap_pct: 0,
      volume: 5000000,
      average_volume_30d: 2000000,
      market_cap: null,
      dividend_yield: 0,
      MA50: 18,
      MA200: 15,
      high_52w: 21,
      low_52w: 10,
      volatility: 0.04,
      return_3m: 5,
      revenue_growth_pct: 0,
      adr_pct: 6,
      ma50_slope: 0.01,
      price_near_daily_high: 0.95,
      consolidation_score: 0.7,
      data_source: 'alpaca+wide-scan',
      imputedFields: ['revenue_growth_pct', 'dividend_yield']
    }
  ];

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'swing_momentum',
    risk: 'medium',
    filters: {},
    wideScan: true
  });

  wideScanUniverseService.scanWideUniverse = originalScanWideUniverse;

  assert.equal(response.meta.source, 'alpaca+wide-scan');
  assert.equal(response.meta.wideScanRequested, true);
  assert.equal(response.meta.wideScanUsed, true);
  assert.ok(!response.analysis.dataQuality.issues.some((issue) => issue.includes('סריקה רחבה')));
  // A wide-scan stock's unknown market_cap must stay null, not silently coerce to 0
  // (Math.round(null) === 0, which would read as "a real, zero-value company").
  assert.equal(response.results[0].market_cap, null);
  assert.ok(!response.results[0].riskOverlay.factors.includes('שווי שוק קטן'));
});

test('wideScan:true falls back to the regular universe (with an honest data-quality note) when the wide scan is unavailable', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const wideScanUniverseService = require('../src/services/wideScanUniverseService');
  const originalScanWideUniverse = wideScanUniverseService.scanWideUniverse;
  wideScanUniverseService.scanWideUniverse = async () => null; // e.g. Alpaca not configured

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'swing_momentum',
    risk: 'medium',
    filters: {},
    wideScan: true
  });

  wideScanUniverseService.scanWideUniverse = originalScanWideUniverse;

  assert.equal(response.meta.wideScanRequested, true);
  assert.equal(response.meta.wideScanUsed, false);
  assert.ok(response.results.length > 0); // regular demo universe still served the scan
  assert.ok(response.analysis.dataQuality.issues.some((issue) => issue.includes('סריקה רחבה')));
});

test('wideScan:true is ignored for a strategy not eligible for it (e.g. micha_stocks)', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const wideScanUniverseService = require('../src/services/wideScanUniverseService');
  const originalScanWideUniverse = wideScanUniverseService.scanWideUniverse;
  let wasCalled = false;
  wideScanUniverseService.scanWideUniverse = async () => {
    wasCalled = true;
    return null;
  };

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {},
    wideScan: true
  });

  wideScanUniverseService.scanWideUniverse = originalScanWideUniverse;

  assert.equal(wasCalled, false);
  assert.equal(response.meta.wideScanRequested, false);
  assert.equal(response.meta.wideScanUsed, false);
});

test('without wideScan, behavior is unchanged (regular universe, no wide-scan fields flipped on)', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'swing_momentum',
    risk: 'medium',
    filters: {}
  });

  assert.equal(response.meta.wideScanRequested, false);
  assert.equal(response.meta.wideScanUsed, false);
  assert.ok(!response.analysis.dataQuality.issues.some((issue) => issue.includes('סריקה רחבה')));
});

test('catalyst flags (earnings/news) are attempted for a short-horizon strategy, left null for a long-horizon one', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const shortResponse = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'swing_momentum',
    risk: 'medium',
    filters: {}
  });
  const longResponse = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {}
  });

  // Without any provider keys, an *attempted* lookup for a short-horizon strategy resolves to a
  // real (negative) answer (false), not null - only a long-horizon strategy (never enriched at
  // all) leaves the field as null ("not attempted").
  assert.ok(shortResponse.results.length > 0);
  assert.ok(shortResponse.results.every((result) => result.hasEarningsSoon === false));
  assert.ok(longResponse.results.length > 0);
  assert.ok(longResponse.results.every((result) => result.hasEarningsSoon === null));
  assert.ok(longResponse.results.every((result) => result.hasRecentNews === null));
});

test('ross_cameron finalists get re-scored with a real share count when the lookup succeeds', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const shareCountService = require('../src/services/shareCountService');
  const originalResolveShareOutstanding = shareCountService.resolveShareOutstanding;

  const baseline = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'ross_cameron', risk: 'medium', filters: {} });

  shareCountService.resolveShareOutstanding = async () => 15000000; // 15M shares -> best float tier
  const withRealFloat = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'ross_cameron', risk: 'medium', filters: {} });

  shareCountService.resolveShareOutstanding = originalResolveShareOutstanding;

  assert.ok(baseline.results.length > 0);
  assert.equal(withRealFloat.results.length, baseline.results.length);
  // Same demo universe/tickers both times - a real (best-tier) float should raise matchScore for
  // at least one finalist that scored on the market-cap proxy's worse tier before.
  const baselineByTicker = new Map(baseline.results.map((result) => [result.ticker, result.matchScore]));
  assert.ok(
    withRealFloat.results.some((result) => result.matchScore > (baselineByTicker.get(result.ticker) ?? -Infinity))
  );
});

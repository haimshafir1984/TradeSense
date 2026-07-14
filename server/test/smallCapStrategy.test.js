const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { scoreStockByStrategy } = require('../src/services/strategies');

function scratchUniverseStorePath() {
  return path.join(os.tmpdir(), `universeCache-strategy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function jsonResponse(data, ok = true) {
  return { ok, json: async () => data, text: async () => JSON.stringify(data) };
}

// Generic FMP responses for the benchmark tickers (SPY/QQQ/IWM) analyzeMarket always fetches -
// same shape as dynamicUniverse.test.js's stockResponses helper.
function benchmarkFmpResponses(url) {
  if (url.includes('/quote')) {
    return jsonResponse([{ price: 500, previousClose: 495, marketCap: 400000000000 }]);
  }
  if (url.includes('/profile')) {
    return jsonResponse([{ companyName: 'Benchmark', sector: 'ETF', mktCap: 400000000000 }]);
  }
  if (url.includes('historical-price-eod')) {
    const closes = Array.from({ length: 210 }, (_, i) => 500 - i * 0.1);
    return jsonResponse(closes.map((close) => ({ close, high: close + 1, low: close - 1, open: close, volume: 1000000 })));
  }
  return jsonResponse([]);
}

// 60 bars oldest-to-newest: flat for 59 sessions, then a gap-up/high-volume/wide-range latest
// session - a clearly-eligible, clearly-scoring small-cap breakout candidate.
function makeSmallCapBars() {
  const bars = [];
  for (let i = 0; i < 59; i += 1) {
    bars.push({ t: `2026-01-${(i % 28) + 1}T00:00:00Z`, o: 10, h: 10.5, l: 9.5, c: 10, v: 100000 });
  }
  bars.push({ t: '2026-03-01T00:00:00Z', o: 10.2, h: 12.5, l: 9.8, c: 12, v: 500000 });
  return bars;
}

function baseStock(overrides = {}) {
  return {
    ticker: 'SCAP',
    price: 15,
    daily_change: 2,
    volume: 2000000,
    average_volume_30d: 1000000,
    market_cap: 500000000,
    high_52w: 16,
    low_52w: 8,
    MA50: 14,
    MA200: 12,
    volatility: 0.04,
    return_3m: 15,
    consolidation_score: 0.5,
    adr_pct: 8,
    gap_pct: 0,
    ...overrides
  };
}

test('eligibility filter zeroes the score for a mega-cap stock', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ market_cap: 50000000000 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('eligibility filter zeroes the score for a sub-$2 stock', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ price: 1.5 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('eligibility filter zeroes the score for a stock with ADR below 5%', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ adr_pct: 3 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('a stock passing eligibility scores above zero', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock(), { benchmarkReturn3m: 0 });
  assert.ok(result.score > 0);
});

test('a bigger volume surge scores higher, all else equal', () => {
  const weakVolume = scoreStockByStrategy('small_cap_breakout', baseStock({ volume: 2000000 }), { benchmarkReturn3m: 0 });
  const strongVolume = scoreStockByStrategy('small_cap_breakout', baseStock({ volume: 4000000 }), { benchmarkReturn3m: 0 });

  assert.ok(strongVolume.score > weakVolume.score);
});

test('a bigger gap scores higher than a small gap, all else equal', () => {
  const smallGap = scoreStockByStrategy('small_cap_breakout', baseStock({ gap_pct: 5, daily_change: 1 }), { benchmarkReturn3m: 0 });
  const bigGap = scoreStockByStrategy('small_cap_breakout', baseStock({ gap_pct: 15, daily_change: 1 }), { benchmarkReturn3m: 0 });

  assert.ok(bigGap.score > smallGap.score);
});

test('analyzeMarket uses the dedicated small-cap universe end-to-end when Alpaca is configured', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  delete process.env.FINNHUB_API_KEY;

  const scratchPath = scratchUniverseStorePath();
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([{ symbol: 'SCAP1', companyName: 'Small Cap Co', sector: 'Technology', marketCap: 500000000, price: 15 }]);
    }
    return benchmarkFmpResponses(url);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/providers/nasdaqService')];
  delete require.cache[require.resolve('../src/services/providers/finnhubService')];
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/universeBuilderService')];
  delete require.cache[require.resolve('../src/services/smallCapUniverseService')];
  delete require.cache[require.resolve('../src/services/scannerService')];

  const alpacaService = require('../src/services/providers/alpacaService');
  alpacaService.getDailyBars = async () => new Map([['SCAP1', makeSmallCapBars()]]);

  const { analyzeMarket } = require('../src/services/scannerService');
  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'small_cap_breakout', risk: 'medium', filters: {} });

  global.fetch = originalFetch;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;
  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(response.meta.source, 'alpaca+fmp-screener');
  assert.ok(response.results.length > 0, 'expected at least one small-cap result');
  assert.equal(response.results[0].ticker, 'SCAP1');
});

test('falls back to the regular universe (without throwing) and reports the issue when Alpaca is not configured', async () => {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const scratchPath = scratchUniverseStorePath();
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/universeBuilderService')];
  delete require.cache[require.resolve('../src/services/smallCapUniverseService')];
  delete require.cache[require.resolve('../src/services/scannerService')];

  const { analyzeMarket } = require('../src/services/scannerService');
  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'small_cap_breakout', risk: 'medium', filters: {} });

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.notEqual(response.meta.source, 'alpaca+fmp-screener');
  assert.ok(
    response.analysis.dataQuality.issues.some((issue) => issue.includes('מאגר מניות קטנות')),
    `expected a small-cap fallback issue, got: ${JSON.stringify(response.analysis.dataQuality.issues)}`
  );
});

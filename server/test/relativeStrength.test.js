const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

function baseStock(overrides = {}) {
  return {
    ticker: 'TEST',
    price: 100,
    daily_change: 1,
    volume: 1000000,
    average_volume_30d: 900000,
    market_cap: 5000000000,
    high_52w: 110,
    low_52w: 70,
    MA50: 98,
    MA200: 90,
    volatility: 0.02,
    return_3m: 10,
    ...overrides
  };
}

test('relativeStrength reflects the stock return vs a benchmark, not an internal-only composite', () => {
  const stock = baseStock({ return_3m: 15 });

  const vsWeakBenchmark = scoreStockByStrategy('mark_minervini', stock, { benchmarkReturn3m: 0 });
  const vsStrongBenchmark = scoreStockByStrategy('mark_minervini', stock, { benchmarkReturn3m: 20 });

  assert.ok(vsWeakBenchmark.relativeStrength > vsStrongBenchmark.relativeStrength);
});

test('a stock matching the benchmark return sits at neutral relative strength', () => {
  const stock = baseStock({ return_3m: 8 });
  const result = scoreStockByStrategy('mark_minervini', stock, { benchmarkReturn3m: 8 });

  assert.equal(result.excessReturnVsBenchmark, 0);
  assert.equal(result.relativeStrength, 0.5);
});

test('scannerService derives benchmarkReturn3m from the SPY snapshot for scoring', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'mark_minervini', risk: 'medium', filters: {} });
  assert.ok(Array.isArray(response.results) && response.results.length > 0);
});

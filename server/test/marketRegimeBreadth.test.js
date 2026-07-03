const test = require('node:test');
const assert = require('node:assert/strict');
const { assessMarketRegime } = require('../src/services/marketRegimeService');

function benchmark(ticker, overrides = {}) {
  return {
    ticker,
    price: 100,
    MA50: 98,
    MA200: 95,
    daily_change: 0.1,
    volatility: 0.02,
    ...overrides
  };
}

function stockAbove(overrides = {}) {
  return { price: 100, MA50: 90, MA200: 85, ...overrides };
}

function stockBelow(overrides = {}) {
  return { price: 80, MA50: 90, MA200: 95, ...overrides };
}

test('wide market breadth pushes regime toward bullish even with a flat benchmark reading', () => {
  const snapshots = [benchmark('SPY'), benchmark('QQQ'), benchmark('IWM')];
  const universeStocks = Array.from({ length: 18 }, () => stockAbove()).concat([stockBelow(), stockBelow()]);

  const result = assessMarketRegime({ snapshots, selectedStrategy: 'micha_stocks', universeStocks });

  assert.equal(result.regime, 'bullish');
  assert.ok(result.indicators.breadth.aboveMA200Pct >= 55);
});

test('narrow market breadth pushes regime toward bearish', () => {
  const snapshots = [benchmark('SPY'), benchmark('QQQ'), benchmark('IWM')];
  const universeStocks = Array.from({ length: 18 }, () => stockBelow()).concat([stockAbove(), stockAbove()]);

  const result = assessMarketRegime({ snapshots, selectedStrategy: 'micha_stocks', universeStocks });

  assert.equal(result.regime, 'bearish');
  assert.ok(result.indicators.breadth.aboveMA200Pct <= 35);
});

test('volatile classification requires genuinely mixed breadth, not just noisy benchmark days', () => {
  // Mixed breadth (~50%) with elevated volatility -> genuinely ambiguous, should be volatile.
  const snapshots = [benchmark('SPY', { daily_change: 0.3 }), benchmark('QQQ', { daily_change: -0.2 }), benchmark('IWM', { daily_change: 0.1 })];
  const universeStocks = Array.from({ length: 10 }, () => stockAbove()).concat(Array.from({ length: 10 }, () => stockBelow()));

  const result = assessMarketRegime({
    snapshots: snapshots.map((s) => ({ ...s, volatility: 0.05 })),
    selectedStrategy: 'ross_cameron',
    universeStocks
  });

  assert.equal(result.regime, 'volatile');
});

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

const bullishUniverse = Array.from({ length: 18 }, () => stockAbove()).concat([stockBelow(), stockBelow()]);
const bearishUniverse = Array.from({ length: 18 }, () => stockBelow()).concat([stockAbove(), stockAbove()]);
const bullishSnapshots = [benchmark('SPY'), benchmark('QQQ'), benchmark('IWM')];

test('recommends swing_momentum in a bullish regime when no league leader exists', () => {
  const result = assessMarketRegime({
    snapshots: bullishSnapshots,
    selectedStrategy: 'micha_stocks',
    universeStocks: bullishUniverse
  });

  assert.equal(result.regime, 'bullish');
  assert.equal(result.recommendedStrategy.key, 'swing_momentum');
  assert.equal(result.recommendedStrategy.source, 'regime');
});

test('recommends nothing (sit out) in a bearish regime when no league leader exists', () => {
  const result = assessMarketRegime({
    snapshots: bullishSnapshots,
    selectedStrategy: 'micha_stocks',
    universeStocks: bearishUniverse
  });

  assert.equal(result.regime, 'bearish');
  assert.equal(result.recommendedStrategy.key, null);
  assert.equal(result.recommendedStrategy.label, 'עדיף להמתין');
  assert.equal(result.recommendedStrategy.source, 'regime');
});

test('a measured strategy league leader overrides the regime-based default recommendation', () => {
  const league = { leadingStrategy: 'ross_cameron' };

  const result = assessMarketRegime({
    snapshots: bullishSnapshots,
    selectedStrategy: 'micha_stocks',
    universeStocks: bullishUniverse,
    league
  });

  assert.equal(result.regime, 'bullish');
  assert.equal(result.recommendedStrategy.key, 'ross_cameron');
  assert.equal(result.recommendedStrategy.source, 'league');
});

test('a league leader also overrides the "sit out" default in a bearish regime', () => {
  const league = { leadingStrategy: 'mark_minervini' };

  const result = assessMarketRegime({
    snapshots: bullishSnapshots,
    selectedStrategy: 'micha_stocks',
    universeStocks: bearishUniverse,
    league
  });

  assert.equal(result.regime, 'bearish');
  assert.equal(result.recommendedStrategy.key, 'mark_minervini');
  assert.equal(result.recommendedStrategy.source, 'league');
});

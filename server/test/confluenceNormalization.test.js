const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCrossStrategyConfluence, buildStrategyScoreDistributions } = require('../src/services/analysisService');

function stock(score, overrides = {}) {
  return {
    ticker: 'X',
    price: 100,
    daily_change: score * 8,
    volume: 1000000 * (1 + score),
    average_volume_30d: 1000000,
    market_cap: 5000000000,
    high_52w: 105,
    low_52w: 80,
    MA50: 95,
    MA200: 90,
    volatility: 0.02,
    return_3m: score * 20,
    consolidation_score: 0.5,
    ma50_slope: 0.01,
    price_near_daily_high: 0.9 + score * 0.05,
    ...overrides
  };
}

test('percentileByStrategy reflects rank within the scanned universe, not a fixed raw threshold', () => {
  // A small universe where raw scores cluster low for every strategy - the same raw score that
  // would fail a fixed 60/70 threshold should still be able to register as "high percentile"
  // if it is the best of a weak batch.
  const universe = [stock(0.1), stock(0.15), stock(0.2), stock(0.25), stock(0.3)];
  const marketContext = { benchmarkReturn3m: 0 };
  const distributions = buildStrategyScoreDistributions(universe, marketContext);

  const best = universe[4];
  const confluence = assessCrossStrategyConfluence({
    stock: best,
    selectedStrategy: 'micha_stocks',
    marketContext,
    scoreDistributions: distributions
  });

  assert.equal(confluence.percentileByStrategy.micha_stocks, 100);
});

test('confluence percentiles are comparable across strategies scanning the same universe', () => {
  const universe = [stock(0.2), stock(0.4), stock(0.6), stock(0.8), stock(0.9)];
  const marketContext = { benchmarkReturn3m: 0 };
  const distributions = buildStrategyScoreDistributions(universe, marketContext);

  const topStock = universe[4];
  const confluenceMicha = assessCrossStrategyConfluence({
    stock: topStock,
    selectedStrategy: 'micha_stocks',
    marketContext,
    scoreDistributions: distributions
  });
  const confluenceRoss = assessCrossStrategyConfluence({
    stock: topStock,
    selectedStrategy: 'ross_cameron',
    marketContext,
    scoreDistributions: distributions
  });

  // Both are percentiles in [0, 100] regardless of each strategy's raw score scale.
  assert.ok(confluenceMicha.percentileByStrategy.micha_stocks >= 0 && confluenceMicha.percentileByStrategy.micha_stocks <= 100);
  assert.ok(confluenceRoss.percentileByStrategy.ross_cameron >= 0 && confluenceRoss.percentileByStrategy.ross_cameron <= 100);
});

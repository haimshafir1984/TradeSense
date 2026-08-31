const test = require('node:test');
const assert = require('node:assert/strict');

function freshServices() {
  delete require.cache[require.resolve('../src/providers/alpacaService')];
  delete require.cache[require.resolve('../src/providers/finnhubService')];
  delete require.cache[require.resolve('../src/pipeline/catalystService')];
  return {
    alpacaService: require('../src/providers/alpacaService'),
    finnhubService: require('../src/providers/finnhubService'),
    catalystService: require('../src/pipeline/catalystService')
  };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stubDefaults(finnhubService, alpacaService, overrides = {}) {
  finnhubService.getEarningsSurprises = overrides.getEarningsSurprises || (async () => null);
  finnhubService.getEarningsSoon = overrides.getEarningsSoon || (async () => false);
  finnhubService.getRecentNewsCount = overrides.getRecentNewsCount || (async () => 0);
  alpacaService.getSnapshots = overrides.getSnapshots || (async () => new Map());
}

test('a fresh, large earnings surprise (within 3 days) is classified as high confidence', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, {
    getEarningsSurprises: async () => [{ period: daysAgoIso(1), actual: 1.5, estimate: 1.2, surprisePercent: 25 }]
  });

  const result = await catalystService.detectCatalysts(['AAPL']);
  const catalyst = result.get('AAPL');

  assert.equal(catalyst.kind, 'earnings_surprise');
  assert.equal(catalyst.confidence, 'high');
  assert.equal(catalyst.earningsSurprisePct, 25);
});

test('an earnings surprise older than the recent window does NOT count as high confidence', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, {
    getEarningsSurprises: async () => [{ period: daysAgoIso(30), actual: 1.5, estimate: 1.2, surprisePercent: 25 }]
  });

  const result = await catalystService.detectCatalysts(['AAPL']);
  const catalyst = result.get('AAPL');

  assert.notEqual(catalyst.kind, 'earnings_surprise');
});

test('a scheduled-but-not-yet-reported earnings date is medium confidence', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, { getEarningsSoon: async () => true });

  const result = await catalystService.detectCatalysts(['EARN']);
  const catalyst = result.get('EARN');

  assert.equal(catalyst.kind, 'earnings_scheduled');
  assert.equal(catalyst.confidence, 'medium');
});

test('a news spike (>= 5 headlines in 48h) is medium confidence when no earnings signal exists', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, { getRecentNewsCount: async () => 7 });

  const result = await catalystService.detectCatalysts(['BUZZ']);
  const catalyst = result.get('BUZZ');

  assert.equal(catalyst.kind, 'news_spike');
  assert.equal(catalyst.confidence, 'medium');
});

test('a real premarket gap with no identified reason is flagged gap_no_news at low confidence', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, {
    getSnapshots: async () =>
      new Map([['GAP', { latestTrade: { p: 110 }, prevDailyBar: { c: 100 } }]])
  });

  const result = await catalystService.detectCatalysts(['GAP']);
  const catalyst = result.get('GAP');

  assert.equal(catalyst.kind, 'gap_no_news');
  assert.equal(catalyst.confidence, 'low');
  assert.equal(catalyst.premarketGapPct, 10);
});

test('nothing found at all returns kind null with low confidence, never a fabricated signal', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService);

  const result = await catalystService.detectCatalysts(['QUIET']);
  const catalyst = result.get('QUIET');

  assert.equal(catalyst.kind, null);
  assert.equal(catalyst.confidence, 'low');
});

test('missing snapshot/finnhub data yields null fields, never zeros standing in for "confirmed none"', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  stubDefaults(finnhubService, alpacaService, {
    getRecentNewsCount: async () => null,
    getEarningsSurprises: async () => null
  });

  const result = await catalystService.detectCatalysts(['NODATA']);
  const catalyst = result.get('NODATA');

  assert.equal(catalyst.earningsSurprisePct, null);
  assert.equal(catalyst.newsCount48h, null);
  assert.equal(catalyst.premarketGapPct, null);
});

test('deduplicates symbols and returns an empty map for an empty input', async () => {
  const { alpacaService, finnhubService, catalystService } = freshServices();
  let callCount = 0;
  stubDefaults(finnhubService, alpacaService, {
    getEarningsSurprises: async () => {
      callCount += 1;
      return null;
    }
  });

  const result = await catalystService.detectCatalysts(['DUPE', 'DUPE', 'DUPE']);
  assert.equal(result.size, 1);
  assert.equal(callCount, 1);

  const empty = await catalystService.detectCatalysts([]);
  assert.equal(empty.size, 0);
});

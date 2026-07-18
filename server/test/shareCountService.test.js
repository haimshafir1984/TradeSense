const test = require('node:test');
const assert = require('node:assert/strict');

function freshShareCountService() {
  delete require.cache[require.resolve('../src/services/providers/finnhubService')];
  delete require.cache[require.resolve('../src/services/shareCountService')];

  return {
    finnhubService: require('../src/services/providers/finnhubService'),
    shareCountService: require('../src/services/shareCountService')
  };
}

test('resolveShareOutstanding uses Finnhub first when configured and it has an answer', async () => {
  const { finnhubService, shareCountService } = freshShareCountService();
  process.env.FINNHUB_API_KEY = 'test-key';

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'Example Corp', shareOutstanding: 10 }) // 10M shares
  });

  const result = await shareCountService.resolveShareOutstanding('EX', 'fmp-key');

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(result, 10000000);
});

test('resolveShareOutstanding falls back to FMP when Finnhub is not configured', async () => {
  const { shareCountService } = freshShareCountService();
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ sharesOutstanding: 25000000 }]
  });

  const result = await shareCountService.resolveShareOutstanding('EX', 'fmp-key');

  global.fetch = originalFetch;

  assert.equal(result, 25000000);
});

test('resolveShareOutstanding returns null when both providers fail or are unavailable', async () => {
  const { shareCountService } = freshShareCountService();
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });

  const resultWithFmpKey = await shareCountService.resolveShareOutstanding('EX', 'fmp-key');
  const resultWithoutFmpKey = await shareCountService.resolveShareOutstanding('EX', null);

  global.fetch = originalFetch;

  assert.equal(resultWithFmpKey, null);
  assert.equal(resultWithoutFmpKey, null);
});

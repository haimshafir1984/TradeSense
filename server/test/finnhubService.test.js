const test = require('node:test');
const assert = require('node:assert/strict');

function freshFinnhubService() {
  delete require.cache[require.resolve('../src/services/providers/finnhubService')];
  return require('../src/services/providers/finnhubService');
}

test('getEarningsSoon returns true when the calendar includes the ticker', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  process.env.FINNHUB_API_KEY = 'test-key';

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ earningsCalendar: [{ symbol: 'EARN', date: '2026-07-16' }] })
  });

  const result = await finnhubService.getEarningsSoon('EARN', 2);

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(result, true);
});

test('getEarningsSoon returns false when the calendar has entries but not for this ticker', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  process.env.FINNHUB_API_KEY = 'test-key';

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ earningsCalendar: [{ symbol: 'OTHER', date: '2026-07-16' }] })
  });

  const result = await finnhubService.getEarningsSoon('EARN', 2);

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(result, false);
});

test('getEarningsSoon returns null (not false) when the key is missing or the request fails', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  delete process.env.FINNHUB_API_KEY;

  const resultWithoutKey = await finnhubService.getEarningsSoon('EARN', 2);
  assert.equal(resultWithoutKey, null);

  process.env.FINNHUB_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 500 });

  const resultOnFailure = await finnhubService.getEarningsSoon('EARN', 2);

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(resultOnFailure, null);
});

test('getCompanyProfile converts Finnhub\'s millions-denominated market cap to raw dollars', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  process.env.FINNHUB_API_KEY = 'test-key';

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'Example Corp', finnhubIndustry: 'Biotechnology', marketCapitalization: 1234.5 })
  });

  const profile = await finnhubService.getCompanyProfile('EX');

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(profile.companyName, 'Example Corp');
  assert.equal(profile.sector, 'Biotechnology');
  assert.equal(profile.marketCap, 1234500000);
});

test('getCompanyProfile also converts shareOutstanding from millions to a raw share count', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  process.env.FINNHUB_API_KEY = 'test-key';

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'Example Corp', marketCapitalization: 100, shareOutstanding: 15.5 })
  });

  const profile = await finnhubService.getCompanyProfile('EX');

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(profile.shareOutstanding, 15500000);
});

test('getRecentNewsCount counts only headlines within the last 48 hours', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  process.env.FINNHUB_API_KEY = 'test-key';

  const nowSeconds = Math.floor(Date.now() / 1000);
  global.fetch = async () => ({
    ok: true,
    json: async () => [
      { datetime: nowSeconds - 3600 }, // 1h ago - within window
      { datetime: nowSeconds - 47 * 3600 }, // 47h ago - within window
      { datetime: nowSeconds - 72 * 3600 } // 72h ago - outside window
    ]
  });

  const count = await finnhubService.getRecentNewsCount('EX');

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(count, 2);
});

test('getRecentNewsCount returns null (not zero) when the key is missing or the request fails', async () => {
  const finnhubService = freshFinnhubService();
  const originalFetch = global.fetch;
  delete process.env.FINNHUB_API_KEY;

  const resultWithoutKey = await finnhubService.getRecentNewsCount('EX');
  assert.equal(resultWithoutKey, null);

  process.env.FINNHUB_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 500 });

  const resultOnFailure = await finnhubService.getRecentNewsCount('EX');

  global.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;

  assert.equal(resultOnFailure, null);
});

test('isConfigured reflects whether FINNHUB_API_KEY is set', () => {
  const finnhubService = freshFinnhubService();

  delete process.env.FINNHUB_API_KEY;
  assert.equal(finnhubService.isConfigured(), false);

  process.env.FINNHUB_API_KEY = 'test-key';
  assert.equal(finnhubService.isConfigured(), true);
  delete process.env.FINNHUB_API_KEY;
});

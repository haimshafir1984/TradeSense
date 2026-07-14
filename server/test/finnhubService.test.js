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

test('isConfigured reflects whether FINNHUB_API_KEY is set', () => {
  const finnhubService = freshFinnhubService();

  delete process.env.FINNHUB_API_KEY;
  assert.equal(finnhubService.isConfigured(), false);

  process.env.FINNHUB_API_KEY = 'test-key';
  assert.equal(finnhubService.isConfigured(), true);
  delete process.env.FINNHUB_API_KEY;
});

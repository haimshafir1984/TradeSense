const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data, ok = true) {
  return { ok, json: async () => data, text: async () => JSON.stringify(data) };
}

function freshSmallCapUniverseService() {
  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/smallCapUniverseService')];
  return {
    smallCapUniverseService: require('../src/services/smallCapUniverseService'),
    alpacaService: require('../src/services/providers/alpacaService')
  };
}

function screenerCandidate(symbol, overrides = {}) {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    sector: 'Technology',
    marketCap: 500000000,
    ...overrides
  };
}

// Bar builder: 60 bars, oldest-to-newest. Bars 0-58 are flat (c=10, h=10.5, l=9.5), bar 59 (the
// latest session) gaps up and ranges wide - chosen so ADR/MA50/high52w/daily_change all have a
// clean hand-computable value (see test 'computes technical fields correctly from known bars').
function makeBars() {
  const bars = [];
  for (let i = 0; i < 59; i += 1) {
    bars.push({ t: `2026-01-${(i % 28) + 1}T00:00:00Z`, o: 10, h: 10.5, l: 9.5, c: 10, v: 100000 });
  }
  bars.push({ t: '2026-03-01T00:00:00Z', o: 10.2, h: 12.5, l: 9.8, c: 12, v: 500000 });
  return bars;
}

test('getSmallCapUniverse returns null when Alpaca is not configured', async () => {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  const { smallCapUniverseService } = freshSmallCapUniverseService();

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  assert.equal(result, null);
});

test('stage 1: screener candidates are sent to Alpaca in a single batched bars request', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([screenerCandidate('SCAP1'), screenerCandidate('SCAP2')]);
    }
    return jsonResponse([]);
  };

  let requestedSymbols = null;
  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async ({ symbols }) => {
    requestedSymbols = symbols;
    return new Map(); // empty -> universe ends up null, we only care about what was requested
  };

  await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.deepEqual(requestedSymbols, ['SCAP1', 'SCAP2']);
});

test('computes technical fields correctly from known bars', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([screenerCandidate('SCAP1', { marketCap: 750000000 })]);
    }
    return jsonResponse([]);
  };

  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async () => new Map([['SCAP1', makeBars()]]);

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(result.length, 1);
  const stock = result[0];

  assert.equal(stock.ticker, 'SCAP1');
  assert.equal(stock.market_cap, 750000000);
  assert.equal(stock.daily_change, 20); // (12 - 10) / 10 * 100
  assert.equal(stock.high_52w, 12.5); // max h across all bars
  assert.equal(stock.MA50, 10.04); // (49 * 10 + 12) / 50
  assert.ok(Math.abs(stock.adr_pct - 11.3775510204) < 0.0001); // 20-bar average of daily ranges
});

test('screener failure returns null', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse(null, false);

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(result, null);
});

test('empty bars from Alpaca returns null', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([screenerCandidate('SCAP1')]);
    }
    return jsonResponse([]);
  };

  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async () => new Map();

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(result, null);
});

test('the Nasdaq screener is tried first and FMP is never called when it succeeds', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  let fmpWasCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('/company-screener')) {
      fmpWasCalled = true;
      return jsonResponse([]);
    }
    const body = {
      data: {
        totalrecords: 1,
        table: {
          rows: [
            { symbol: 'SCAP1', name: 'SCAP1 Inc Common Stock', lastsale: '10.00', marketCap: '750,000,000', pctchange: '1.0%' }
          ]
        }
      }
    };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };

  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async () => new Map([['SCAP1', makeBars()]]);

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(fmpWasCalled, false);
  assert.equal(result.length, 1);
  assert.equal(result[0].ticker, 'SCAP1');
  assert.equal(result[0].market_cap, 750000000);
  assert.equal(result[0].data_source, 'alpaca+nasdaq');
});

test('FMP is used as the screener fallback when the Nasdaq screener fails', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/company-screener')) {
      return jsonResponse([screenerCandidate('SCAP1')]);
    }
    return { ok: false, status: 403 };
  };

  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async () => new Map([['SCAP1', makeBars()]]);

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(result.length, 1);
  assert.equal(result[0].ticker, 'SCAP1');
  assert.equal(result[0].data_source, 'alpaca+fmp-screener');
});

test('a symbol with fewer than 60 bars is skipped without affecting other symbols', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';
  const { smallCapUniverseService, alpacaService } = freshSmallCapUniverseService();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([screenerCandidate('SHORT'), screenerCandidate('SCAP1')]);
    }
    return jsonResponse([]);
  };

  const shortBars = makeBars().slice(0, 30); // under MIN_BARS_FOR_UNIVERSE
  const originalGetDailyBars = alpacaService.getDailyBars;
  alpacaService.getDailyBars = async () =>
    new Map([
      ['SHORT', shortBars],
      ['SCAP1', makeBars()]
    ]);

  const result = await smallCapUniverseService.getSmallCapUniverse({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  alpacaService.getDailyBars = originalGetDailyBars;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FMP_API_KEY;

  assert.equal(result.length, 1);
  assert.equal(result[0].ticker, 'SCAP1');
});

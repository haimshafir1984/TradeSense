const test = require('node:test');
const assert = require('node:assert/strict');

function freshNasdaqService() {
  delete require.cache[require.resolve('../src/services/providers/nasdaqService')];
  return require('../src/services/providers/nasdaqService');
}

// nasdaqService reads the raw body via response.text() first (so it can detect a 200 + HTML
// block-page from Akamai instead of assuming any 2xx is valid JSON) - every mock response needs a
// text() that matches its json() data.
function jsonHttpResponse(data) {
  return { ok: true, text: async () => JSON.stringify(data) };
}

test('getScreenerRows parses comma/dollar/percent-formatted fields into plain numbers', async () => {
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;

  global.fetch = async () => jsonHttpResponse({
    data: {
      totalrecords: 1,
      table: {
        rows: [
          { symbol: 'SRPT', name: 'Sarepta Therapeutics, Inc. Common Stock (DE)', lastsale: '$18.82', marketCap: '1,986,944,498', pctchange: '-0.686%' }
        ]
      }
    }
  });

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 200 });

  global.fetch = originalFetch;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'SRPT');
  assert.equal(rows[0].companyName, 'Sarepta Therapeutics, Inc.');
  assert.equal(rows[0].price, 18.82);
  assert.equal(rows[0].marketCap, 1986944498);
  assert.equal(rows[0].dailyChangePct, -0.686);
});

test('getScreenerRows paginates via offset until totalrecords is reached', async () => {
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;
  const requestedUrls = [];

  function makeRow(index) {
    return { symbol: `T${index}`, name: `Ticker ${index} Common Stock`, lastsale: '10.00', marketCap: '500,000,000', pctchange: '1.0%' };
  }

  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    const offsetMatch = String(url).match(/offset=(\d+)/);
    const offset = Number(offsetMatch[1]);
    const rows = offset === 0
      ? Array.from({ length: 200 }, (_, i) => makeRow(i))
      : Array.from({ length: 50 }, (_, i) => makeRow(200 + i));

    return jsonHttpResponse({ data: { totalrecords: 250, table: { rows } } });
  };

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 250 });

  global.fetch = originalFetch;

  assert.equal(rows.length, 250);
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls[0].includes('offset=0'));
  assert.ok(requestedUrls[1].includes('offset=200'));
});

test('getScreenerRows filters out warrant/unit/preferred symbols containing / . or ^', async () => {
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;

  global.fetch = async () => jsonHttpResponse({
    data: {
      totalrecords: 4,
      table: {
        rows: [
          { symbol: 'ABC', name: 'ABC Corp Common Stock', lastsale: '5.00', marketCap: '100,000,000', pctchange: '0.5%' },
          { symbol: 'ABC/WS', name: 'ABC Corp Warrants', lastsale: '1.00', marketCap: '10,000,000', pctchange: '0.1%' },
          { symbol: 'ABC.U', name: 'ABC Corp Units', lastsale: '10.00', marketCap: '100,000,000', pctchange: '0.2%' },
          { symbol: 'ABC^A', name: 'ABC Corp Preferred', lastsale: '25.00', marketCap: '50,000,000', pctchange: '0.0%' }
        ]
      }
    }
  });

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 200 });

  global.fetch = originalFetch;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ABC');
});

test('getScreenerRows returns null when the HTTP request fails', async () => {
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: false, status: 403 });

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 200 });

  global.fetch = originalFetch;

  assert.equal(rows, null);
});

test('getScreenerRows returns null (not a throw) when the response is 200 with a non-JSON body', async () => {
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: true, text: async () => '<html>Access Denied</html>' });

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 200 });

  global.fetch = originalFetch;

  assert.equal(rows, null);
});

test('getScreenerRows returns null (not a hang) when the request never resolves', async () => {
  process.env.NASDAQ_REQUEST_TIMEOUT_MS = '50';
  const nasdaqService = freshNasdaqService();
  const originalFetch = global.fetch;

  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const rows = await nasdaqService.getScreenerRows({ exchange: 'NASDAQ', limit: 200 });

  global.fetch = originalFetch;
  delete process.env.NASDAQ_REQUEST_TIMEOUT_MS;

  assert.equal(rows, null);
});

test('isAvailable always returns true (no API key required)', () => {
  const nasdaqService = freshNasdaqService();
  assert.equal(nasdaqService.isAvailable(), true);
});

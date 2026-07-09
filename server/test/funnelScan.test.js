const test = require('node:test');
const assert = require('node:assert/strict');

function clearAlpacaEnv() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
}

function setAlpacaEnv() {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
}

// Builds a plausible daily-bar series (oldest to newest) for one symbol, with the last bar's
// close/open/volume overridable independently so a test can control daily_change / gap /
// dollar-volume precisely while the rest of the series just fills in ADR/volumeRatio/high52w.
function buildBars({
  days = 25,
  basePrice = 20,
  rangePct = 6,
  volume = 1000000,
  lastClose,
  lastOpen,
  lastVolume
} = {}) {
  const bars = [];
  let previousClose = basePrice;

  for (let index = 0; index < days; index += 1) {
    const isLast = index === days - 1;
    const open = isLast && lastOpen !== undefined ? lastOpen : previousClose;
    const close = isLast && lastClose !== undefined ? lastClose : basePrice;
    const halfRange = (Math.max(close, open) * rangePct) / 200;
    const high = Math.max(close, open) + halfRange;
    const low = Math.max(0.01, Math.min(close, open) - halfRange);
    const vol = isLast && lastVolume !== undefined ? lastVolume : volume;

    bars.push({
      t: new Date(2026, 0, index + 1).toISOString(),
      o: Number(open.toFixed(2)),
      h: Number(high.toFixed(2)),
      l: Number(low.toFixed(2)),
      c: Number(close.toFixed(2)),
      v: vol
    });

    previousClose = close;
  }

  return bars;
}

function freshFunnelScanService() {
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/watchlistScoring')];
  delete require.cache[require.resolve('../src/services/funnelScanService')];

  const alpacaService = require('../src/services/providers/alpacaService');
  const funnelScanService = require('../src/services/funnelScanService');
  return { alpacaService, funnelScanService };
}

// Wires the mocked alpacaService methods from a symbol -> full bar[] map: getActiveAssets returns
// one asset per symbol, getLatestDailyBars derives the latest bar from the same series (so a test
// only has to define bars once per symbol), getDailyBars returns the full series.
function mockAlpaca(alpacaService, barsBySymbol, { assetsOverride } = {}) {
  const symbols = Object.keys(barsBySymbol);

  alpacaService.isConfigured = () => true;
  alpacaService.getActiveAssets = async () =>
    assetsOverride || symbols.map((symbol) => ({ symbol, name: `${symbol} Inc`, exchange: 'NASDAQ' }));
  alpacaService.getLatestDailyBars = async ({ symbols: requested }) => {
    const map = new Map();
    for (const symbol of requested) {
      const bars = barsBySymbol[symbol];
      if (bars && bars.length) {
        map.set(symbol, bars[bars.length - 1]);
      }
    }
    return map;
  };
  alpacaService.getDailyBars = async ({ symbols: requested }) => {
    const map = new Map();
    for (const symbol of requested) {
      if (barsBySymbol[symbol]) {
        map.set(symbol, barsBySymbol[symbol]);
      }
    }
    return map;
  };
}

function jsonResponse(data, ok = true) {
  return { ok, json: async () => data };
}

test('scanForGapAndGo returns null when Alpaca keys are missing', async () => {
  clearAlpacaEnv();
  const { funnelScanService } = freshFunnelScanService();

  const result = await funnelScanService.scanForGapAndGo({ exchange: 'NASDAQ' });

  assert.equal(result, null);
});

test('coarse stage-1 filter drops a symbol below the minimum dollar volume', async () => {
  setAlpacaEnv();
  const { alpacaService, funnelScanService } = freshFunnelScanService();

  const barsBySymbol = {
    WINNER: buildBars({ basePrice: 20, rangePct: 6, volume: 1200000, lastClose: 21.6, lastOpen: 20.2, lastVolume: 3200000 }),
    // Price is in-band ($2) but volume is tiny -> dollar volume ~ $2,400, far below the 5,000,000 floor.
    THIN: buildBars({ basePrice: 2, rangePct: 6, volume: 1200, lastClose: 2.1, lastOpen: 2.0, lastVolume: 1200 })
  };

  mockAlpaca(alpacaService, barsBySymbol);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/profile')) {
      return jsonResponse([{ companyName: 'Winner Inc', mktCap: 2000000000 }]);
    }
    return jsonResponse([]);
  };

  const result = await funnelScanService.scanForGapAndGo({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.ok(Array.isArray(result));
  const tickers = result.map((candidate) => candidate.ticker);
  assert.ok(tickers.includes('WINNER'));
  assert.ok(!tickers.includes('THIN'));
});

test('stage 2 rejects a symbol whose ADR is below the threshold', async () => {
  setAlpacaEnv();
  const { alpacaService, funnelScanService } = freshFunnelScanService();

  const barsBySymbol = {
    WINNER: buildBars({ basePrice: 20, rangePct: 6, volume: 1200000, lastClose: 21.6, lastOpen: 20.2, lastVolume: 3200000 }),
    // Passes the stage-1 dollar-volume/price/rough-change filter, but its daily range is only ~1%,
    // well under MIN_ADR_PCT (3), so it must be rejected in stage 2.
    FLAT: buildBars({ basePrice: 20, rangePct: 1, volume: 1200000, lastClose: 20.4, lastOpen: 20.1, lastVolume: 1500000 })
  };

  mockAlpaca(alpacaService, barsBySymbol);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/profile')) {
      return jsonResponse([{ companyName: 'Co', mktCap: 2000000000 }]);
    }
    return jsonResponse([]);
  };

  const result = await funnelScanService.scanForGapAndGo({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  const tickers = result.map((candidate) => candidate.ticker);
  assert.ok(tickers.includes('WINNER'));
  assert.ok(!tickers.includes('FLAT'));
});

test('stage 3 rejects a finalist above the market cap ceiling, and keeps one whose profile lookup failed (market_cap: null)', async () => {
  setAlpacaEnv();
  const { alpacaService, funnelScanService } = freshFunnelScanService();

  const barsBySymbol = {
    BIGCAP: buildBars({ basePrice: 20, rangePct: 6, volume: 1200000, lastClose: 21.6, lastOpen: 20.2, lastVolume: 3200000 }),
    NOPROFILE: buildBars({ basePrice: 30, rangePct: 6, volume: 1200000, lastClose: 32.4, lastOpen: 30.3, lastVolume: 3200000 })
  };

  mockAlpaca(alpacaService, barsBySymbol);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/profile')) {
      if (String(url).includes('symbol=BIGCAP')) {
        return jsonResponse([{ companyName: 'Big Cap Inc', mktCap: 50000000000 }]);
      }
      // NOPROFILE's profile lookup fails outright - should not disqualify the candidate.
      return jsonResponse(null, false);
    }
    return jsonResponse([]);
  };
  process.env.FMP_API_KEY = 'test-fmp-key';

  const result = await funnelScanService.scanForGapAndGo({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  delete process.env.FMP_API_KEY;
  clearAlpacaEnv();

  const tickers = result.map((candidate) => candidate.ticker);
  assert.ok(!tickers.includes('BIGCAP'));
  assert.ok(tickers.includes('NOPROFILE'));

  const noProfile = result.find((candidate) => candidate.ticker === 'NOPROFILE');
  assert.equal(noProfile.market_cap, null);
  assert.match(noProfile.reason, /שווי שוק/);
});

test('end-to-end: assets -> bars -> filtering -> FMP enrichment returns correctly shaped, rank-sorted candidates', async () => {
  setAlpacaEnv();
  const { alpacaService, funnelScanService } = freshFunnelScanService();

  const barsBySymbol = {
    STRONG: buildBars({ basePrice: 20, rangePct: 8, volume: 1000000, lastClose: 22.6, lastOpen: 20.4, lastVolume: 4000000 }),
    MILD: buildBars({ basePrice: 15, rangePct: 5, volume: 1000000, lastClose: 15.6, lastOpen: 15.1, lastVolume: 1500000 })
  };

  mockAlpaca(alpacaService, barsBySymbol);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/profile')) {
      return jsonResponse([{ companyName: 'Enriched Co', mktCap: 1500000000 }]);
    }
    if (String(url).includes('earnings-calendar')) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };
  process.env.FMP_API_KEY = 'test-fmp-key';

  const result = await funnelScanService.scanForGapAndGo({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  delete process.env.FMP_API_KEY;
  clearAlpacaEnv();

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);

  for (const candidate of result) {
    assert.equal(candidate.dataSource, 'alpaca+fmp');
    assert.equal(typeof candidate.ticker, 'string');
    assert.equal(typeof candidate.companyName, 'string');
    assert.equal(typeof candidate.price, 'number');
    assert.equal(typeof candidate.daily_change, 'number');
    assert.equal(typeof candidate.volumeRatio, 'number');
    assert.equal(typeof candidate.adr_pct, 'number');
    assert.equal(typeof candidate.highProximity, 'number');
    assert.equal(candidate.market_cap, 1500000000);
    assert.equal(typeof candidate.rankScore, 'number');
    assert.equal(typeof candidate.reason, 'string');
    assert.equal(candidate.hasEarningsSoon, false);
  }

  assert.equal(result[0].ticker, 'STRONG'); // higher daily_change/volumeRatio -> higher rankScore
  assert.ok(result[0].rankScore >= result[1].rankScore);
});

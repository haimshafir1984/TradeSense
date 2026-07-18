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

// Same shape/idiom as funnelScan.test.js's buildBars - a plausible oldest-to-newest daily-bar
// series with the last bar overridable, so ADR/MA50/high52w come out of real math rather than
// being hand-faked, while daily_change/volume on the latest session stay test-controlled.
function buildBars({ days = 65, basePrice = 20, rangePct = 6, volume = 1000000, lastClose, lastVolume } = {}) {
  const bars = [];

  for (let index = 0; index < days; index += 1) {
    const isLast = index === days - 1;
    const close = isLast && lastClose !== undefined ? lastClose : basePrice;
    const halfRange = (close * rangePct) / 200;
    const vol = isLast && lastVolume !== undefined ? lastVolume : volume;

    bars.push({
      t: new Date(2026, 0, index + 1).toISOString(),
      o: basePrice,
      h: Number((close + halfRange).toFixed(2)),
      l: Number(Math.max(0.01, close - halfRange).toFixed(2)),
      c: Number(close.toFixed(2)),
      v: vol
    });
  }

  return bars;
}

function freshWideScanUniverseService() {
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/wideScanUniverseService')];

  const alpacaService = require('../src/services/providers/alpacaService');
  const wideScanUniverseService = require('../src/services/wideScanUniverseService');
  return { alpacaService, wideScanUniverseService };
}

// Same pattern as funnelScan.test.js's mockAlpaca.
function mockAlpaca(alpacaService, barsBySymbol) {
  const symbols = Object.keys(barsBySymbol);

  alpacaService.isConfigured = () => true;
  alpacaService.getActiveAssets = async () => symbols.map((symbol) => ({ symbol, name: `${symbol} Inc`, exchange: 'NASDAQ' }));
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

test('scanWideUniverse returns null when Alpaca is not configured', async () => {
  clearAlpacaEnv();
  const { wideScanUniverseService } = freshWideScanUniverseService();

  const result = await wideScanUniverseService.scanWideUniverse({ exchange: 'NASDAQ' });

  assert.equal(result, null);
});

test('coarse stage-1 filter drops a symbol below the minimum dollar volume, keeps a liquid one', async () => {
  setAlpacaEnv();
  const { alpacaService, wideScanUniverseService } = freshWideScanUniverseService();

  const barsBySymbol = {
    LIQUID: buildBars({ basePrice: 20, lastClose: 21, lastVolume: 1000000 }), // $21M dollar volume
    THIN: buildBars({ basePrice: 2, lastClose: 2.1, lastVolume: 1000 }) // ~$2,100 dollar volume
  };
  mockAlpaca(alpacaService, barsBySymbol);

  const result = await wideScanUniverseService.scanWideUniverse({ exchange: 'NASDAQ' });

  clearAlpacaEnv();

  assert.equal(result.length, 1);
  assert.equal(result[0].ticker, 'LIQUID');
});

test('builds a full stock object from bars with no market cap and the wide-scan data source label', async () => {
  setAlpacaEnv();
  const { alpacaService, wideScanUniverseService } = freshWideScanUniverseService();

  mockAlpaca(alpacaService, { WIDE1: buildBars({ basePrice: 20, lastClose: 22 }) });

  const result = await wideScanUniverseService.scanWideUniverse({ exchange: 'NASDAQ' });

  clearAlpacaEnv();

  assert.equal(result.length, 1);
  const stock = result[0];
  assert.equal(stock.ticker, 'WIDE1');
  assert.equal(stock.price, 22);
  assert.equal(stock.market_cap, null);
  assert.equal(stock.data_source, 'alpaca+wide-scan');
  assert.ok(Number.isFinite(stock.adr_pct));
});

test('a symbol with too few bars for the ADR/MA window is skipped without affecting others', async () => {
  setAlpacaEnv();
  const { alpacaService, wideScanUniverseService } = freshWideScanUniverseService();

  mockAlpaca(alpacaService, {
    SHORT: buildBars({ days: 30, basePrice: 20, lastClose: 21 }), // under MIN_BARS_FOR_WIDE_SCAN (60)
    OK: buildBars({ days: 65, basePrice: 20, lastClose: 21 })
  });

  const result = await wideScanUniverseService.scanWideUniverse({ exchange: 'NASDAQ' });

  clearAlpacaEnv();

  assert.equal(result.length, 1);
  assert.equal(result[0].ticker, 'OK');
});

test('empty asset list or empty latest-bars map returns null (Alpaca reachable but no data)', async () => {
  setAlpacaEnv();
  const { alpacaService, wideScanUniverseService } = freshWideScanUniverseService();

  alpacaService.isConfigured = () => true;
  alpacaService.getActiveAssets = async () => [];

  const result = await wideScanUniverseService.scanWideUniverse({ exchange: 'NASDAQ' });

  clearAlpacaEnv();

  assert.equal(result, null);
});

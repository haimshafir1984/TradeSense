// Single adapter for all communication with Alpaca Market Data / Trading API (v2). No other file
// is allowed to call fetch() against Alpaca directly - this keeps a future provider (Tiingo/Stooq)
// a drop-in behind the same shape, and keeps auth/rate-limiting/error-handling in one place. See
// docs/SPEC_DATA_FUNNEL.md section 3.1.
//
// Fail-soft by design: every non-2xx response or thrown exception is caught here, logged with
// console.warn, and turned into an empty result (null / empty Map) - never thrown. Callers
// (funnelScanService.js) treat "no usable data" as the signal to fall back to the existing FMP
// universe path.

const DATA_BASE_URL = process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets';
const TRADING_BASE_URL = process.env.ALPACA_TRADING_BASE_URL || 'https://api.alpaca.markets';

// Only an exact match on these two exchanges - Alpaca also returns ARCA/BATS/OTC/etc, which we
// deliberately do NOT fold into NYSE (see spec 3.1).
const ALLOWED_EXCHANGES = new Set(['NASDAQ', 'NYSE']);

// Alpaca's free tier allows 200 requests/minute; stay a bit under that so we never actually hit
// a 429 from normal usage, and no new dependency is pulled in for the throttling itself.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 190;
let requestTimestamps = [];

// Alpaca's bars endpoint has a practical URL-length limit; splitting symbols into chunks keeps
// every request well under it regardless of how large the universe gets.
const SYMBOLS_PER_CHUNK = 200;

// ~90 calendar days covers ~60 trading days once weekends/holidays are removed, which is what the
// funnel's stage-2 ADR/volume-ratio/52w-high calculations need (spec 3.1/3.2).
const DEFAULT_HISTORY_DAYS = 90;
// Cheap "just the latest session" lookback for the coarse stage-1 filter - small enough that a
// short window can't accidentally miss the most recent trading day around a long weekend.
const LATEST_BAR_LOOKBACK_DAYS = 7;

function isConfigured() {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function authHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY
  };
}

async function throttle() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldest = requestTimestamps[0];
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  requestTimestamps.push(Date.now());
}

async function fetchAlpaca(url, label) {
  try {
    await throttle();
    const response = await fetch(url, { headers: authHeaders() });

    if (!response.ok) {
      console.warn(`[alpaca] ${label} failed: HTTP ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(`[alpaca] ${label} failed: ${error.message}`);
    return null;
  }
}

// GET /v2/assets - the "stage 1 universe" source: every active, tradable US equity on the
// requested exchange, filtered down to plain common-stock-looking tickers (no preferred shares /
// warrants, which use "/" or "." in their symbol).
async function getActiveAssets({ exchange } = {}) {
  if (!ALLOWED_EXCHANGES.has(exchange)) {
    return [];
  }

  const url = `${TRADING_BASE_URL}/v2/assets?status=active&asset_class=us_equity`;
  const data = await fetchAlpaca(url, `getActiveAssets:${exchange}`);

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((asset) => asset && asset.tradable === true && asset.exchange === exchange)
    .filter((asset) => typeof asset.symbol === 'string' && !asset.symbol.includes('/') && !asset.symbol.includes('.'))
    .map((asset) => ({ symbol: asset.symbol, name: asset.name || asset.symbol, exchange: asset.exchange }));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// GET /v2/stocks/bars - daily OHLCV bars for up to `days` calendar days back, for every symbol
// given. Returns Map<symbol, bar[]> sorted oldest-to-newest per symbol, exactly as the API's
// sort=asc gives us (merged across pagination and chunk boundaries).
async function getDailyBars({ symbols = [], days = DEFAULT_HISTORY_DAYS } = {}) {
  const result = new Map();

  if (!Array.isArray(symbols) || symbols.length === 0) {
    return result;
  }

  const start = new Date();
  start.setDate(start.getDate() - days);
  const startDate = start.toISOString().slice(0, 10);

  const symbolChunks = chunk(symbols, SYMBOLS_PER_CHUNK);

  for (const symbolChunk of symbolChunks) {
    let pageToken = null;

    do {
      const params = new URLSearchParams({
        symbols: symbolChunk.join(','),
        timeframe: '1Day',
        start: startDate,
        limit: '10000',
        adjustment: 'split',
        feed: 'iex',
        sort: 'asc'
      });

      if (pageToken) {
        params.set('page_token', pageToken);
      }

      const url = `${DATA_BASE_URL}/v2/stocks/bars?${params.toString()}`;
      const data = await fetchAlpaca(url, 'getDailyBars');

      if (!data) {
        pageToken = null;
        break;
      }

      const barsBySymbol = data.bars || {};
      for (const [symbol, bars] of Object.entries(barsBySymbol)) {
        if (!Array.isArray(bars) || !bars.length) {
          continue;
        }
        const existing = result.get(symbol) || [];
        result.set(symbol, existing.concat(bars));
      }

      pageToken = data.next_page_token || null;
    } while (pageToken);
  }

  for (const bars of result.values()) {
    bars.sort((left, right) => new Date(left.t).getTime() - new Date(right.t).getTime());
  }

  return result;
}

// Cheap variant of getDailyBars for the coarse stage-1 filter: only the most recent bar per
// symbol, over a short lookback window so the request/response stays small.
async function getLatestDailyBars({ symbols = [] } = {}) {
  const barsBySymbol = await getDailyBars({ symbols, days: LATEST_BAR_LOOKBACK_DAYS });
  const latest = new Map();

  for (const [symbol, bars] of barsBySymbol) {
    if (bars.length) {
      latest.set(symbol, bars[bars.length - 1]);
    }
  }

  return latest;
}

module.exports = {
  isConfigured,
  getActiveAssets,
  getDailyBars,
  getLatestDailyBars
};

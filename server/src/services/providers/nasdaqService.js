// Adapter for Nasdaq's public screener endpoint (api.nasdaq.com) - used ahead of FMP's
// rate-limited/quota-capped screener for stock lists + market cap. This is an *unofficial* API (it
// serves nasdaq.com's own site, not a documented/versioned product) and could change shape or
// start blocking requests without notice - every caller must treat a null return as "fall back to
// the existing FMP screener path", not as "no stocks exist". See
// docs/SPEC_PROVIDER_REBALANCE.md section 3.
//
// No API key needed, but the request must look like a browser (accept + user-agent) or Nasdaq
// rejects it outright.

const BASE_URL = process.env.NASDAQ_API_BASE_URL || 'https://api.nasdaq.com';
const REQUEST_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  referer: 'https://www.nasdaq.com/market-activity/stocks/screener',
  origin: 'https://www.nasdaq.com'
};

// This is an unofficial API sitting behind Akamai, which sometimes filters non-browser traffic
// (datacenter IPs, TLS fingerprint) by simply never responding - without a timeout that hangs the
// caller instead of failing soft. Overridable so tests don't have to wait out a real 10s timeout.
// See docs/SPEC_UNIVERSE_RESILIENCE.md section 3.
const REQUEST_TIMEOUT_MS = Number(process.env.NASDAQ_REQUEST_TIMEOUT_MS) || 10 * 1000;

// Conservative self-throttle out of courtesy to an unofficial endpoint - no documented limit to
// aim for, unlike Alpaca/Finnhub.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
let requestTimestamps = [];

const PAGE_SIZE = 200;
// Warrants/preferred/rights use these characters in their symbol - not plain common stock.
const EXCLUDED_SYMBOL_CHARS = ['/', '.', '^'];

function isAvailable() {
  return true;
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

async function fetchNasdaq(url, label) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    await throttle();
    const response = await fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal });

    if (!response.ok) {
      console.warn(`[nasdaq] ${label} failed: HTTP ${response.status}`);
      return null;
    }

    const rawBody = await response.text();

    try {
      return JSON.parse(rawBody);
    } catch {
      // Akamai sometimes answers with 200 + an HTML block page instead of a real error status -
      // logging a snippet is what actually lets us diagnose that from Render's logs.
      console.warn(`[nasdaq] ${label} failed: non-JSON response (likely bot-blocked). body starts with: ${rawBody.slice(0, 50)}`);
      return null;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(`[nasdaq] ${label} failed: timed out after ${REQUEST_TIMEOUT_MS}ms`);
    } else {
      console.warn(`[nasdaq] ${label} failed: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// "1,986,944,498" / "$18.82" / "-0.686%" -> plain numbers. Returns null (not NaN/0) for anything
// unparseable so callers can distinguish "no data" from "genuinely zero".
function parseNumericField(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/[$,%]/g, '').trim();
  if (!cleaned || cleaned.toUpperCase() === 'N/A') {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRow(row) {
  const rawSymbol = row?.symbol;
  if (!rawSymbol || typeof rawSymbol !== 'string') {
    return null;
  }

  const symbol = rawSymbol.trim();
  if (!symbol || EXCLUDED_SYMBOL_CHARS.some((char) => symbol.includes(char))) {
    return null;
  }

  const companyName = String(row.name || symbol)
    .replace(/ (Common|Ordinary).*$/i, '')
    .trim() || symbol;

  return {
    symbol,
    companyName,
    marketCap: parseNumericField(row.marketCap),
    price: parseNumericField(row.lastsale),
    dailyChangePct: parseNumericField(row.pctchange)
  };
}

// GET /api/screener/stocks, paginated (Nasdaq caps each response at PAGE_SIZE rows regardless of
// the requested limit). Returns up to `limit` normalized rows, or null if the very first page
// failed/came back empty - a partial result from a later page failing mid-pagination is still
// returned (fail-soft: better a shorter real list than throwing away what we already fetched).
async function getScreenerRows({ exchange = 'NASDAQ', marketCapTiers = null, limit = 200 } = {}) {
  const rows = [];
  let offset = 0;
  let totalRecords = Infinity;

  while (rows.length < limit && offset < totalRecords) {
    const params = new URLSearchParams({
      tableonly: 'true',
      limit: String(PAGE_SIZE),
      offset: String(offset),
      exchange
    });

    if (Array.isArray(marketCapTiers) && marketCapTiers.length) {
      params.set('marketcap', marketCapTiers.join('|'));
    }

    const url = `${BASE_URL}/api/screener/stocks?${params.toString()}`;
    const data = await fetchNasdaq(url, `getScreenerRows:${exchange}:offset=${offset}`);

    if (!data) {
      break;
    }

    const table = data?.data?.table;
    const pageRows = Array.isArray(table?.rows) ? table.rows : [];
    const reportedTotal = Number(data?.data?.totalrecords ?? table?.totalrecords);
    totalRecords = Number.isFinite(reportedTotal) ? reportedTotal : pageRows.length;

    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      const normalized = normalizeRow(row);
      if (normalized) {
        rows.push(normalized);
      }
    }

    offset += PAGE_SIZE;
  }

  return rows.length ? rows.slice(0, limit) : null;
}

module.exports = {
  isAvailable,
  getScreenerRows
};

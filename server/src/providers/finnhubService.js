// Adapter for Finnhub's free tier (60 calls/min, no daily cap) - earnings dates/surprises,
// company profile, and recent news. See docs/SPEC_PROVIDER_REBALANCE.md section 4 and
// docs/SPEC_V2_ARCHITECTURE.md §3.3/§7.2.
//
// Reuses the FINNHUB_API_KEY env var.

const BASE_URL = 'https://finnhub.io/api/v1';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 50;
let requestTimestamps = [];
let requestQueue = Promise.resolve();

function isConfigured() {
  return Boolean(process.env.FINNHUB_API_KEY);
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

async function fetchFinnhub(url, label) {
  try {
    const slot = requestQueue.then(throttle);
    requestQueue = slot.catch(() => {});
    await slot;
    let response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (response.status === 429) {
      const delay = Math.min(60000, Math.max(2000, Number(response.headers?.get?.('retry-after') || 5) * 1000));
      await new Promise(resolve => setTimeout(resolve, delay));
      const retry = requestQueue.then(throttle);
      requestQueue = retry.catch(() => {});
      await retry;
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    }

    if (!response.ok) {
      console.warn(`[finnhub] ${label} failed: HTTP ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(`[finnhub] ${label} failed: ${error.message}`);
    return null;
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Returns true/false when the answer is known, or null when Finnhub couldn't be asked (not
// configured, or the request failed) - callers must treat null as "unknown, ask FMP instead", not
// as "confirmed no earnings".
async function getEarningsSoon(ticker, lookaheadDays = 2) {
  if (!isConfigured()) {
    return null;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const today = new Date();
  const until = new Date(today.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  const url = `${BASE_URL}/calendar/earnings?from=${formatDate(today)}&to=${formatDate(until)}&symbol=${ticker}&token=${apiKey}`;
  const data = await fetchFinnhub(url, `getEarningsSoon:${ticker}`);

  if (!data) {
    return null;
  }

  const entries = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : null;
  if (!entries) {
    return null;
  }

  return entries.some((entry) => entry?.symbol === ticker);
}

// Returns { companyName, sector, marketCap, shareOutstanding } or null if unavailable. marketCap
// and shareOutstanding are converted from Finnhub's millions-denominated fields to raw
// dollars/shares, matching every other provider's convention. shareOutstanding is total shares
// outstanding, not the narrower "free float" (shares actually available to trade, excluding
// insider/institutional locks) - no free-tier provider exposes true float, but this is a real
// figure rather than the market-cap-tier guess in strategies.js#scoreFloatProxy. See
// docs/SPEC_SHORT_TERM_UPGRADE.md step 5.
async function getCompanyProfile(ticker) {
  if (!isConfigured()) {
    return null;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const url = `${BASE_URL}/stock/profile2?symbol=${ticker}&token=${apiKey}`;
  const data = await fetchFinnhub(url, `getCompanyProfile:${ticker}`);

  if (!data || !data.name) {
    return null;
  }

  const marketCapMillions = Number(data.marketCapitalization);
  const shareOutstandingMillions = Number(data.shareOutstanding);

  return {
    companyName: data.name,
    sector: data.finnhubIndustry || null,
    marketCap: Number.isFinite(marketCapMillions) ? marketCapMillions * 1000000 : null,
    shareOutstanding: Number.isFinite(shareOutstandingMillions) ? shareOutstandingMillions * 1000000 : null
  };
}

// Company-news headline count in the last 48h - a flag only, never scored (see
// docs/SPEC_SHORT_TERM_UPGRADE.md step 5: "יש אירוע חדשותי - בדוק לפני החלטה", not a signal that
// feeds any strategy's score). Returns null when unknown (not configured or the request failed) -
// callers must not treat null as "confirmed zero news".
const NEWS_LOOKBACK_HOURS = 48;

async function getRecentNewsCount(ticker) {
  if (!isConfigured()) {
    return null;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const today = new Date();
  // Requests a slightly wider window than the lookback itself (Finnhub's `from`/`to` are
  // date-only, not timestamps), then filters precisely by `datetime` below.
  const from = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
  const url = `${BASE_URL}/company-news?symbol=${ticker}&from=${formatDate(from)}&to=${formatDate(today)}&token=${apiKey}`;
  const data = await fetchFinnhub(url, `getRecentNewsCount:${ticker}`);

  if (!Array.isArray(data)) {
    return null;
  }

  const cutoffMs = Date.now() - NEWS_LOOKBACK_HOURS * 60 * 60 * 1000;
  return data.filter((item) => Number.isFinite(item?.datetime) && item.datetime * 1000 >= cutoffMs).length;
}

async function getCompanyNewsMetadata({ symbol, from, to, limit = 50 } = {}) {
  if (!isConfigured() || !symbol || !from || !to) {
    return { configured: isConfigured(), items: null, errorKind: isConfigured() ? 'invalid_request' : 'not_configured' };
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const url = `${BASE_URL}/company-news?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(formatDate(new Date(from)))}&to=${encodeURIComponent(formatDate(new Date(to)))}&token=${apiKey}`;
  const data = await fetchFinnhub(url, `getCompanyNewsMetadata:${symbol}`);
  if (!Array.isArray(data)) {
    return { configured: true, items: null, errorKind: 'provider_error' };
  }
  const maxItems = Math.min(100, Math.max(1, Number(limit) || 50));
  return {
    configured: true,
    items: data
      .filter((item) => item && item.datetime != null && Number.isFinite(Number(item.datetime)))
      .sort((left, right) => Number(left.datetime) - Number(right.datetime))
      .slice(0, maxItems)
      .map((item) => ({
        provider: 'finnhub',
        id: item.id == null ? null : String(item.id),
        datetime: new Date(Number(item.datetime) * 1000).toISOString(),
        source: item.source || null,
        headline: typeof item.headline === 'string' ? item.headline.slice(0, 300) : null,
        url: item.url || null,
        related: item.related || symbol,
        summaryHash: typeof item.summary === 'string' ? String(item.summary.length) : null,
        fetchedAt: new Date().toISOString(),
      })),
    errorKind: null,
  };
}

// GET /stock/earnings - historical EPS actual-vs-estimate surprises (docs/SPEC_V2_ARCHITECTURE.md
// §7.2), most-recent quarter first as Finnhub returns them. Used by playbooks/peadDrift.js to
// detect a numeric earnings surprise, and by ledger:backfill to reconstruct past surprise dates.
// Returns null (never an empty array standing in for "no surprises") when the request itself
// failed or wasn't configured - an empty array is a legitimate "no data for this ticker" answer
// and callers must be able to tell the two apart.
async function getEarningsSurprises(ticker) {
  if (!isConfigured()) {
    return null;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const url = `${BASE_URL}/stock/earnings?symbol=${ticker}&token=${apiKey}`;
  const data = await fetchFinnhub(url, `getEarningsSurprises:${ticker}`);

  if (!Array.isArray(data)) {
    return null;
  }

  return data
    .filter((entry) => entry && entry.period)
    .map((entry) => ({
      period: entry.period,
      actual: Number.isFinite(Number(entry.actual)) ? Number(entry.actual) : null,
      estimate: Number.isFinite(Number(entry.estimate)) ? Number(entry.estimate) : null,
      surprisePercent: Number.isFinite(Number(entry.surprisePercent)) ? Number(entry.surprisePercent) : null
    }));
}

module.exports = {
  isConfigured,
  getEarningsSoon,
  getCompanyProfile,
  getRecentNewsCount,
  getCompanyNewsMetadata,
  getEarningsSurprises
};

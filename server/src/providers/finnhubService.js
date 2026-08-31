// Adapter for Finnhub's free tier (60 calls/min, no daily cap) - used for earnings-date and
// company-profile lookups so the funnel/watchlist earnings check no longer depends on FMP's
// exhaustible 250 call/day quota. See docs/SPEC_PROVIDER_REBALANCE.md section 4.
//
// Reuses the FINNHUB_API_KEY env var already read by marketDataService.js's existing
// DATA_MODE=finnhub path.

const BASE_URL = 'https://finnhub.io/api/v1';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 50;
let requestTimestamps = [];

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
    await throttle();
    const response = await fetch(url);

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

module.exports = {
  isConfigured,
  getEarningsSoon,
  getCompanyProfile,
  getRecentNewsCount
};

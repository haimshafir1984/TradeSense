// Shared gap-and-go scoring/thresholds used by both watchlistService.js (the FMP-universe path)
// and funnelScanService.js (the Alpaca funnel path), so the two paths never drift apart and never
// score the same raw signal twice under two different formulas (LOGIC_IMPROVEMENTS.md 3.1).
// Pulled out into its own module - rather than exported from watchlistService.js directly - so
// funnelScanService.js can depend on it without a circular require back into watchlistService.js
// (which itself calls funnelScanService.js). See docs/SPEC_DATA_FUNNEL.md section 3.2.
const { clamp, round } = require('./mathUtils');
const finnhubService = require('./providers/finnhubService');

// Loosened from the original 4% / 1.5x - combined with a small scanned universe, the stricter
// thresholds meant "no candidates" most days even on live data. Still selective enough to filter
// out genuinely quiet stocks, just less all-or-nothing.
const MAX_WATCHLIST_SIZE = 10;
const MARKET_CAP_CEILING = 10000000000;
const MIN_ADR_PCT = 3;
const MIN_VOLUME_RATIO = 1.2;

// ~3 trading days, approximated with calendar days to absorb a weekend in between (same
// calendar-day approximation used for EVALUATION_HORIZON_DAYS in scanHistoryService.js).
const EARNINGS_LOOKAHEAD_CALENDAR_DAYS = 5;

function normalize(value, min, max) {
  if (max <= min) {
    return 0;
  }

  return clamp((value - min) / (max - min));
}

// Simple weighted blend of the three things that matter for a gap-and-go candidate: how much it
// already moved, how unusual the volume is, and how close it is to breaking out.
function computeRankScore({ dailyChange, volumeRatio, highProximity }) {
  return (
    normalize(dailyChange, 0, 15) * 0.4 +
    normalize(volumeRatio, 1.5, 5) * 0.35 +
    normalize(highProximity, 0.85, 1) * 0.25
  );
}

function buildReason(dailyChange, volumeRatio, adrPct, highProximity) {
  const parts = [
    `עלייה יומית של ${round(dailyChange, 1)}%`,
    `נפח מסחר פי ${round(volumeRatio, 1)} מהממוצע`,
    `טווח תנודה יומי (ADR) של ${round(adrPct, 1)}%`
  ];

  if (highProximity >= 0.95) {
    parts.push('קרבה לשיא השנתי');
  }

  return parts.join(', ');
}

async function checkEarningsSoon(ticker, apiKey) {
  try {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + EARNINGS_LOOKAHEAD_CALENDAR_DAYS);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    const url = `https://financialmodelingprep.com/stable/earnings-calendar?symbol=${ticker}&from=${fromDate}&to=${toDate}&apikey=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    // FMP's free tier ignores the `symbol` query parameter and returns the whole general
    // calendar, so an unfiltered length check flags *every* stock as "earnings soon". Only count
    // entries that actually belong to this ticker.
    return Array.isArray(data) && data.some((entry) => entry?.symbol === ticker);
  } catch (error) {
    console.warn(`[watchlist] Earnings calendar lookup failed for ${ticker}: ${error.message}`);
    return false;
  }
}

// Finnhub first (no daily quota), FMP's earnings calendar as the fallback only when Finnhub
// couldn't answer (not configured, or its request failed) - see
// docs/SPEC_PROVIDER_REBALANCE.md section 5.2/5.3. Shared by both funnelScanService.js and
// watchlistService.js so the two paths use the same chain instead of duplicating it.
async function resolveEarningsSoon(ticker, fmpApiKey) {
  const finnhubResult = await finnhubService.getEarningsSoon(ticker, EARNINGS_LOOKAHEAD_CALENDAR_DAYS);
  if (finnhubResult !== null) {
    return finnhubResult;
  }

  if (!fmpApiKey) {
    return false;
  }

  return checkEarningsSoon(ticker, fmpApiKey);
}

module.exports = {
  MAX_WATCHLIST_SIZE,
  MARKET_CAP_CEILING,
  MIN_ADR_PCT,
  MIN_VOLUME_RATIO,
  normalize,
  computeRankScore,
  buildReason,
  checkEarningsSoon,
  resolveEarningsSoon
};

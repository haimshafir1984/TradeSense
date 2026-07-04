// Called as marketDataService.getMarketData(...) rather than destructured, so tests can
// monkey-patch the export without needing to reload this module (same pattern as
// scanHistoryService.js).
const marketDataService = require('./marketDataService');
const { clamp, round } = require('./mathUtils');

// Turns the EOD-only limitation into an advantage: instead of trying (and failing) to compete
// with real-time day-trading tools, an evening scan surfaces gap-and-go candidates for the next
// session's open. See docs/LOGIC_IMPROVEMENTS.md - Watchlist for Tomorrow.
const MAX_WATCHLIST_SIZE = 10;
const MARKET_CAP_CEILING = 10000000000;
const MIN_ADR_PCT = 4;
const MIN_VOLUME_RATIO = 1.5;

// ~3 trading days, approximated with calendar days to absorb a weekend in between (same
// calendar-day approximation used for EVALUATION_HORIZON_DAYS in scanHistoryService.js).
const EARNINGS_LOOKAHEAD_CALENDAR_DAYS = 5;

async function buildTomorrowWatchlist({ exchange = 'NASDAQ' } = {}) {
  const { stocks } = await marketDataService.getMarketData(exchange);

  const candidates = stocks
    .map(enrichCandidate)
    .filter(matchesGapAndGoProfile)
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, MAX_WATCHLIST_SIZE);

  const apiKey = process.env.FMP_API_KEY;
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      hasEarningsSoon: apiKey ? await checkEarningsSoon(candidate.ticker, apiKey) : false
    }))
  );
}

function enrichCandidate(stock) {
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;
  const highProximity = stock.high_52w ? stock.price / stock.high_52w : 0;
  const adrPct = Number(stock.adr_pct || 0);
  const dailyChange = Number(stock.daily_change || 0);

  // Simple weighted blend of the three things that matter for a gap-and-go candidate: how much it
  // already moved, how unusual the volume is, and how close it is to breaking out.
  const rankScore =
    normalize(dailyChange, 0, 15) * 0.4 +
    normalize(volumeRatio, 1.5, 5) * 0.35 +
    normalize(highProximity, 0.85, 1) * 0.25;

  return {
    ticker: stock.ticker,
    companyName: stock.companyName,
    price: round(stock.price, 2),
    daily_change: round(dailyChange, 2),
    volumeRatio: round(volumeRatio, 2),
    adr_pct: round(adrPct, 2),
    highProximity: round(highProximity, 3),
    market_cap: Math.round(stock.market_cap),
    rankScore: round(rankScore, 4),
    reason: buildReason(dailyChange, volumeRatio, adrPct, highProximity)
  };
}

function matchesGapAndGoProfile(candidate) {
  return (
    candidate.market_cap < MARKET_CAP_CEILING &&
    candidate.adr_pct >= MIN_ADR_PCT &&
    candidate.volumeRatio >= MIN_VOLUME_RATIO &&
    candidate.daily_change > 0
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
    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.warn(`[watchlist] Earnings calendar lookup failed for ${ticker}: ${error.message}`);
    return false;
  }
}

function normalize(value, min, max) {
  if (max <= min) {
    return 0;
  }

  return clamp((value - min) / (max - min));
}

module.exports = {
  buildTomorrowWatchlist
};

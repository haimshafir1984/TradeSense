// Real shares-outstanding lookup for ross_cameron's float scoring (docs/SPEC_SHORT_TERM_UPGRADE.md
// step 5): a real (if imperfect - total shares outstanding, not the narrower "free float" that no
// free-tier API exposes) figure instead of the market-cap-tier guess in
// strategies.js#scoreFloatProxy. Finnhub first (no daily quota), FMP as a fallback, null if both
// fail/aren't configured - same chain shape as resolveEarningsSoon/resolveMarketCap elsewhere in
// this codebase. Intended for Top-10 finalists only, not the whole scanned universe.
const finnhubService = require('./providers/finnhubService');

async function resolveShareOutstanding(ticker, fmpApiKey) {
  if (finnhubService.isConfigured()) {
    const profile = await finnhubService.getCompanyProfile(ticker);
    if (profile && Number.isFinite(profile.shareOutstanding) && profile.shareOutstanding > 0) {
      return profile.shareOutstanding;
    }
  }

  if (!fmpApiKey) {
    return null;
  }

  return fetchFmpShareOutstanding(ticker, fmpApiKey);
}

async function fetchFmpShareOutstanding(ticker, apiKey) {
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const profile = Array.isArray(data) ? data[0] : data;
    const shares = Number(profile?.sharesOutstanding);
    return Number.isFinite(shares) && shares > 0 ? shares : null;
  } catch (error) {
    console.warn(`[shareCount] FMP profile lookup failed for ${ticker}: ${error.message}`);
    return null;
  }
}

module.exports = {
  resolveShareOutstanding
};

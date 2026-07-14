// The funnel scan engine (docs/SPEC_DATA_FUNNEL.md section 3.2): turns an Alpaca-backed universe
// of thousands of US equities into a handful of gap-and-go finalists, in three narrowing stages -
// wide-and-cheap (all active assets, one coarse local filter), medium (full history for the
// survivors, exact local filter + ranking), narrow-and-expensive (FMP enrichment for the top few
// only). If Alpaca isn't configured, or stage 1 fails outright, this returns null so the caller
// (watchlistService.js) falls back to the existing FMP-universe path unchanged.
const alpacaService = require('./providers/alpacaService');
const finnhubService = require('./providers/finnhubService');
const { round, average } = require('./mathUtils');
const {
  MAX_WATCHLIST_SIZE,
  MARKET_CAP_CEILING,
  MIN_ADR_PCT,
  MIN_VOLUME_RATIO,
  computeRankScore,
  buildReason,
  resolveEarningsSoon
} = require('./watchlistScoring');

const FUNNEL_MIN_PRICE = Number(process.env.FUNNEL_MIN_PRICE) || 1;
const FUNNEL_MAX_PRICE = Number(process.env.FUNNEL_MAX_PRICE) || 500;
const FUNNEL_MIN_DOLLAR_VOLUME = Number(process.env.FUNNEL_MIN_DOLLAR_VOLUME) || 5000000;
const FUNNEL_STAGE2_SIZE = Number(process.env.FUNNEL_STAGE2_SIZE) || 300;
const FUNNEL_FINALISTS = Number(process.env.FUNNEL_FINALISTS) || 20;

// Minimum bars needed for stage 2's ADR/volume-ratio math to mean anything (20-day ADR window +
// a previous-close comparison).
const MIN_BARS_FOR_STAGE2 = 21;

async function scanForGapAndGo({ exchange = 'NASDAQ' } = {}) {
  if (!alpacaService.isConfigured()) {
    return null;
  }

  const stage1Survivors = await runStage1(exchange);
  if (stage1Survivors === null) {
    return null;
  }

  if (!stage1Survivors.length) {
    return [];
  }

  const stage2Finalists = await runStage2(stage1Survivors);
  if (!stage2Finalists.length) {
    return [];
  }

  return runStage3(stage2Finalists);
}

// Stage 1 - wide and cheap: every active asset on the exchange, filtered locally on the single
// latest daily bar (price band, dollar volume, a rough same-day change). Returns the surviving
// { symbol, name } entries (sorted by the rough change, capped at FUNNEL_STAGE2_SIZE), or null if
// the asset list or bar fetch came back empty (Alpaca unreachable/misconfigured).
async function runStage1(exchange) {
  const assets = await alpacaService.getActiveAssets({ exchange });
  if (!assets.length) {
    return null;
  }

  const nameBySymbol = new Map(assets.map((asset) => [asset.symbol, asset.name]));
  const symbols = assets.map((asset) => asset.symbol);
  const latestBars = await alpacaService.getLatestDailyBars({ symbols });

  if (!latestBars.size) {
    return null;
  }

  const survivors = [];

  for (const [symbol, bar] of latestBars) {
    const close = Number(bar?.c);
    const open = Number(bar?.o);
    const volume = Number(bar?.v);

    if (!Number.isFinite(close) || !Number.isFinite(open) || !Number.isFinite(volume) || open <= 0) {
      continue;
    }

    if (close < FUNNEL_MIN_PRICE || close > FUNNEL_MAX_PRICE) {
      continue;
    }

    const dollarVolume = close * volume;
    if (dollarVolume < FUNNEL_MIN_DOLLAR_VOLUME) {
      continue;
    }

    // No previous close available yet at this stage - (close - open) / open is a rough-but-cheap
    // stand-in for "moved up today", good enough for a coarse filter (spec 3.2 stage 1).
    const roughChange = (close - open) / open;
    if (roughChange <= 0) {
      continue;
    }

    survivors.push({ symbol, name: nameBySymbol.get(symbol) || symbol, roughChange });
  }

  return survivors
    .sort((left, right) => right.roughChange - left.roughChange)
    .slice(0, FUNNEL_STAGE2_SIZE);
}

// Stage 2 - full 90-day history for the stage-1 survivors, computing the same
// ADR/volumeRatio/highProximity/daily_change signals the FMP path uses, applying the existing
// gap-and-go thresholds, and ranking with the shared rankScore formula. Returns up to
// FUNNEL_FINALISTS candidates in the same shape enrichCandidate() produces (minus market_cap,
// which only Alpaca can't supply and gets filled in stage 3).
async function runStage2(stage1Survivors) {
  const nameBySymbol = new Map(stage1Survivors.map((entry) => [entry.symbol, entry.name]));
  const symbols = stage1Survivors.map((entry) => entry.symbol);
  const barsBySymbol = await alpacaService.getDailyBars({ symbols, days: 90 });

  const results = [];

  for (const symbol of symbols) {
    const bars = barsBySymbol.get(symbol);
    if (!bars || bars.length < MIN_BARS_FOR_STAGE2) {
      continue;
    }

    const last = bars[bars.length - 1];
    const previous = bars[bars.length - 2];
    const price = Number(last?.c);
    const previousClose = Number(previous?.c);

    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) {
      continue;
    }

    const dailyChange = ((price - previousClose) / previousClose) * 100;

    const last20 = bars.slice(-20);
    const adrValues = last20
      .filter((bar) => Number.isFinite(bar.h) && Number.isFinite(bar.l) && bar.l > 0)
      .map((bar) => ((bar.h - bar.l) / bar.l) * 100);
    const adrPct = adrValues.length ? average(adrValues) : 0;

    const volume = Number(last?.v) || 0;
    const last30Volumes = bars.slice(-30).map((bar) => Number(bar.v)).filter(Number.isFinite);
    const averageVolume30d = last30Volumes.length ? average(last30Volumes) : 0;
    const volumeRatio = averageVolume30d ? volume / averageVolume30d : 0;

    const highs = bars.map((bar) => Number(bar.h)).filter(Number.isFinite);
    const high52w = highs.length ? Math.max(...highs) : 0;
    const highProximity = high52w ? price / high52w : 0;

    if (adrPct < MIN_ADR_PCT || volumeRatio < MIN_VOLUME_RATIO || !(dailyChange > 0)) {
      continue;
    }

    const rankScore = computeRankScore({ dailyChange, volumeRatio, highProximity });

    results.push({
      ticker: symbol,
      companyName: nameBySymbol.get(symbol) || symbol,
      price: round(price, 2),
      daily_change: round(dailyChange, 2),
      volumeRatio: round(volumeRatio, 2),
      adr_pct: round(adrPct, 2),
      highProximity: round(highProximity, 3),
      rankScore: round(rankScore, 4),
      reason: buildReason(dailyChange, volumeRatio, adrPct, highProximity)
    });
  }

  return results
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, FUNNEL_FINALISTS);
}

// Stage 3 - enrichment for the finalists only (market cap + company name, plus the earnings-soon
// check). Market cap and earnings are each resolved via Finnhub first (no daily quota) and FMP as
// the fallback (docs/SPEC_PROVIDER_REBALANCE.md section 5.2). A failed lookup on both does NOT
// disqualify the candidate - it's left with market_cap: null and a reason noting the missing
// figure (fail-soft, spec 3.2 stage 3). Candidates with a known market cap at/above
// MARKET_CAP_CEILING are dropped.
async function runStage3(finalists) {
  const apiKey = process.env.FMP_API_KEY;

  const enriched = await Promise.all(
    finalists.map((candidate) => enrichCandidate(candidate, apiKey))
  );

  return enriched
    .filter((candidate) => candidate.market_cap === null || candidate.market_cap < MARKET_CAP_CEILING)
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, MAX_WATCHLIST_SIZE);
}

async function enrichCandidate(candidate, apiKey) {
  const [{ marketCap, companyName }, hasEarningsSoon] = await Promise.all([
    resolveMarketCap(candidate.ticker, apiKey),
    resolveEarningsSoon(candidate.ticker, apiKey)
  ]);

  return {
    ...candidate,
    companyName: companyName || candidate.companyName,
    market_cap: marketCap,
    reason: marketCap === null ? `${candidate.reason}, אין נתון שווי שוק זמין` : candidate.reason,
    hasEarningsSoon,
    dataSource: 'alpaca+fmp'
  };
}

// Finnhub profile first (no daily quota), FMP /profile as the fallback, null if both fail/aren't
// configured.
async function resolveMarketCap(ticker, apiKey) {
  if (finnhubService.isConfigured()) {
    const profile = await finnhubService.getCompanyProfile(ticker);
    if (profile && Number.isFinite(profile.marketCap)) {
      return { marketCap: Math.round(profile.marketCap), companyName: profile.companyName };
    }
  }

  if (!apiKey) {
    return { marketCap: null, companyName: null };
  }

  const profile = await fetchFmpProfile(ticker, apiKey);
  const marketCap = profile && Number.isFinite(Number(profile.mktCap)) ? Math.round(Number(profile.mktCap)) : null;
  return { marketCap, companyName: profile?.companyName || null };
}

async function fetchFmpProfile(ticker, apiKey) {
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return Array.isArray(data) ? data[0] || null : data || null;
  } catch (error) {
    console.warn(`[funnelScan] FMP profile lookup failed for ${ticker}: ${error.message}`);
    return null;
  }
}

module.exports = {
  scanForGapAndGo
};

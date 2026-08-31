// Stage 1 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.1). The layer that decides whether
// there's any reason to expect an asymmetric move at all - a price move with no identified
// catalyst is symmetric noise (§0 fact 1), and this is the only layer that can tell the two apart.
const alpacaService = require('../providers/alpacaService');
const finnhubService = require('../providers/finnhubService');

const RECENT_EARNINGS_WINDOW_DAYS = 3; // matches P1 (peadDrift)'s own "reported in the last 1-3
// trading days" eligibility window (§5.3) - catalystService flags it as `high` confidence exactly
// when it's fresh enough for that playbook to actually use.
const NEWS_SPIKE_THRESHOLD = 5;
const CONCURRENCY = 5;

// Runs `worker(item)` over `items` with at most `concurrency` in flight at once - same pattern as
// universeBuilderService.js#enrichMarketCaps, reused here because Finnhub has no batch endpoint
// for per-symbol lookups (unlike Alpaca's snapshots, which are fetched in one call below).
async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
}

function daysBetween(laterIso, earlierIso) {
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) {
    return null;
  }
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

// Alpaca's raw snapshot shape -> a plain premarket gap percentage. null when either price is
// missing - never a fabricated 0 (§1 rule 1).
function premarketGapPctFromSnapshot(snapshot) {
  const latestPrice = Number(snapshot?.latestTrade?.p ?? snapshot?.dailyBar?.c);
  const previousClose = Number(snapshot?.prevDailyBar?.c);

  if (!Number.isFinite(latestPrice) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return null;
  }

  return ((latestPrice - previousClose) / previousClose) * 100;
}

async function detectCatalystForSymbol(symbol, snapshot) {
  const now = new Date().toISOString();

  const [surprises, earningsScheduled, newsCount48h] = await Promise.all([
    finnhubService.getEarningsSurprises(symbol),
    finnhubService.getEarningsSoon(symbol, 2),
    finnhubService.getRecentNewsCount(symbol)
  ]);

  const mostRecentSurprise = Array.isArray(surprises) && surprises.length ? surprises[0] : null;
  const daysSinceEarnings = mostRecentSurprise ? daysBetween(now, mostRecentSurprise.period) : null;
  const earningsSurprisePct = mostRecentSurprise ? mostRecentSurprise.surprisePercent : null;
  const premarketGapPct = premarketGapPctFromSnapshot(snapshot);

  const hasRecentSurprise =
    earningsSurprisePct !== null && daysSinceEarnings !== null && daysSinceEarnings >= 0 && daysSinceEarnings <= RECENT_EARNINGS_WINDOW_DAYS;

  if (hasRecentSurprise) {
    return {
      kind: 'earnings_surprise',
      earningsSurprisePct,
      daysSinceEarnings,
      newsCount48h,
      premarketGapPct,
      confidence: 'high'
    };
  }

  if (earningsScheduled === true) {
    return {
      kind: 'earnings_scheduled',
      earningsSurprisePct,
      daysSinceEarnings,
      newsCount48h,
      premarketGapPct,
      confidence: 'medium'
    };
  }

  if (Number.isFinite(newsCount48h) && newsCount48h >= NEWS_SPIKE_THRESHOLD) {
    return {
      kind: 'news_spike',
      earningsSurprisePct,
      daysSinceEarnings,
      newsCount48h,
      premarketGapPct,
      confidence: 'medium'
    };
  }

  if (Number.isFinite(premarketGapPct) && Math.abs(premarketGapPct) >= 3) {
    // A real gap with no identified reason - flagged as a warning-grade catalyst (§5.1), not a
    // quality signal. Exactly the symmetric-noise case §0 warns against trusting.
    return {
      kind: 'gap_no_news',
      earningsSurprisePct,
      daysSinceEarnings,
      newsCount48h,
      premarketGapPct,
      confidence: 'low'
    };
  }

  return {
    kind: null,
    earningsSurprisePct,
    daysSinceEarnings,
    newsCount48h,
    premarketGapPct,
    confidence: 'low'
  };
}

async function detectCatalysts(symbols) {
  const result = new Map();
  const uniqueSymbols = [...new Set(Array.isArray(symbols) ? symbols : [])];

  if (!uniqueSymbols.length) {
    return result;
  }

  const snapshots = await alpacaService.getSnapshots({ symbols: uniqueSymbols });

  await runWithConcurrency(uniqueSymbols, CONCURRENCY, async (symbol) => {
    const catalyst = await detectCatalystForSymbol(symbol, snapshots.get(symbol));
    result.set(symbol, catalyst);
  });

  return result;
}

module.exports = {
  detectCatalysts,
  premarketGapPctFromSnapshot
};

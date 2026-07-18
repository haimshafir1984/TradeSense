const { readScanHistory, writeScanHistory } = require('./scanHistoryStore');
// Called as marketDataService.getStockSnapshot(...) rather than destructured, so tests can
// monkey-patch the export without needing to reload this module.
const marketDataService = require('./marketDataService');
const { round } = require('./mathUtils');

// This is the feedback loop the rest of the scoring logic has no way to validate itself against:
// without it, opportunityRank/successProbability-style numbers are just formulas that were never
// checked against what stocks actually did. See docs/LOGIC_IMPROVEMENTS.md section 5.1.
//
// Horizons are calendar days, not trading days, as a simple approximation - see EVALUATION_HORIZON_DAYS.
const EVALUATION_HORIZON_DAYS = {
  ross_cameron: 5,
  swing_momentum: 10,
  small_cap_breakout: 10,
  mark_minervini: 20,
  micha_stocks: 60
};
const DEFAULT_HORIZON_DAYS = 20;

const OPPORTUNITY_RANK_BUCKETS = [
  { label: '0-39', min: 0, max: 39 },
  { label: '40-59', min: 40, max: 59 },
  { label: '60-79', min: 60, max: 79 },
  { label: '80-100', min: 80, max: 100 }
];

// Strategy league window/threshold: see docs/LOGIC_IMPROVEMENTS.md - Strategy League.
const LEAGUE_WINDOW_DAYS = 90;
const LEAGUE_MIN_SAMPLES_TO_LEAD = 10;

async function recordScan({ exchange, strategy, risk, results = [], spyPriceAtScan, strategyTopPicks = {}, source }) {
  if (!Number.isFinite(spyPriceAtScan) || spyPriceAtScan <= 0 || !results.length) {
    return null;
  }

  const scans = await readScanHistory();

  // The selected strategy's own results (as shown to the user), tagged with `selected: true`.
  const selectedResults = results.map((result) => ({
    strategy,
    ticker: result.ticker,
    priceAtScan: result.price,
    opportunityRank: result.opportunityRank,
    matchScore: result.matchScore,
    score: Number.isFinite(result.matchScore) ? round(result.matchScore / 100, 4) : null,
    selected: true,
    outcome: null
  }));

  // Top-5 picks from every other strategy, scored against the same universe, so the strategy
  // league can measure how each strategy would have done - not just the one the user picked.
  const otherResults = Object.entries(strategyTopPicks)
    .filter(([strategyKey]) => strategyKey !== strategy)
    .flatMap(([strategyKey, picks]) =>
      (picks || []).map((pick) => ({
        strategy: strategyKey,
        ticker: pick.ticker,
        priceAtScan: pick.price,
        opportunityRank: null,
        matchScore: null,
        score: pick.score,
        selected: false,
        outcome: null
      }))
    );

  const entry = {
    id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    scannedAt: new Date().toISOString(),
    exchange,
    strategy,
    risk,
    // Only set when the caller (e.g. shadowScanService) tags the scan explicitly - omitted for
    // ordinary manual scans so existing scanHistory.json records (which never had this field)
    // and their consumers stay byte-identical. See docs/SPEC_SHORT_TERM_UPGRADE.md step 1.
    ...(source ? { source } : {}),
    benchmark: { ticker: 'SPY', priceAtScan: spyPriceAtScan },
    results: [...selectedResults, ...otherResults]
  };

  scans.push(entry);
  await writeScanHistory(scans);
  return entry;
}

function getHorizonDays(strategy) {
  return EVALUATION_HORIZON_DAYS[strategy] || DEFAULT_HORIZON_DAYS;
}

async function evaluateOutcomes({ now = new Date() } = {}) {
  const scans = await readScanHistory();
  let evaluatedCount = 0;
  const spyPriceCache = { value: null };

  for (const scan of scans) {
    const ageDays = (now.getTime() - new Date(scan.scannedAt).getTime()) / (24 * 60 * 60 * 1000);

    // Each result carries its own strategy (it may differ from the scan's selected strategy for
    // the "other strategies" league picks), so it becomes eligible on its own horizon.
    const pendingResults = scan.results.filter((result) => {
      if (result.outcome) {
        return false;
      }
      const horizonDays = getHorizonDays(result.strategy || scan.strategy);
      return ageDays >= horizonDays;
    });

    if (!pendingResults.length) {
      continue;
    }

    if (spyPriceCache.value === null) {
      const spySnapshot = await marketDataService.getStockSnapshot('SPY');
      spyPriceCache.value = Number(spySnapshot?.price) || null;
    }

    if (!spyPriceCache.value) {
      continue;
    }

    const benchmarkReturnPct = ((spyPriceCache.value - scan.benchmark.priceAtScan) / scan.benchmark.priceAtScan) * 100;

    for (const result of pendingResults) {
      const snapshot = await marketDataService.getStockSnapshot(result.ticker);
      const currentPrice = Number(snapshot?.price);

      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(result.priceAtScan) || result.priceAtScan <= 0) {
        continue;
      }

      const stockReturnPct = ((currentPrice - result.priceAtScan) / result.priceAtScan) * 100;
      const excessReturnPct = stockReturnPct - benchmarkReturnPct;

      result.outcome = {
        evaluatedAt: now.toISOString(),
        horizonDays: getHorizonDays(result.strategy || scan.strategy),
        stockReturnPct: round(stockReturnPct, 2),
        benchmarkReturnPct: round(benchmarkReturnPct, 2),
        excessReturnPct: round(excessReturnPct, 2),
        hit: excessReturnPct > 0
      };
      evaluatedCount += 1;
    }
  }

  if (evaluatedCount > 0) {
    await writeScanHistory(scans);
  }

  return { evaluatedCount };
}

function findOpportunityRankBucket(opportunityRank) {
  return OPPORTUNITY_RANK_BUCKETS.find((bucket) => opportunityRank >= bucket.min && opportunityRank <= bucket.max)?.label || 'unknown';
}

function summarize(entries) {
  const total = entries.length;
  const hits = entries.filter((entry) => entry.outcome.hit).length;
  const avgExcessReturnPct = total
    ? entries.reduce((sum, entry) => sum + entry.outcome.excessReturnPct, 0) / total
    : 0;

  return {
    count: total,
    hits,
    hitRatePct: total ? round((hits / total) * 100, 1) : null,
    avgExcessReturnPct: round(avgExcessReturnPct, 2)
  };
}

// The league only compares evaluated (outcome-known) entries scanned within the trailing window,
// so a strategy can't "lead" on stale results from months ago. A strategy is only declared the
// leader once it has enough samples to not be a fluke; below that, leadingStrategy stays null.
function buildLeague(evaluatedEntries) {
  const cutoffMs = Date.now() - LEAGUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentEntries = evaluatedEntries.filter((entry) => new Date(entry.scannedAt).getTime() >= cutoffMs);

  const byStrategy = {};
  for (const strategyKey of Object.keys(EVALUATION_HORIZON_DAYS)) {
    byStrategy[strategyKey] = summarize(recentEntries.filter((entry) => entry.strategy === strategyKey));
  }

  let leadingStrategy = null;
  let bestExcess = -Infinity;

  for (const [strategyKey, stats] of Object.entries(byStrategy)) {
    if (stats.count >= LEAGUE_MIN_SAMPLES_TO_LEAD && stats.avgExcessReturnPct > bestExcess) {
      bestExcess = stats.avgExcessReturnPct;
      leadingStrategy = strategyKey;
    }
  }

  return {
    windowDays: LEAGUE_WINDOW_DAYS,
    minSamplesToLead: LEAGUE_MIN_SAMPLES_TO_LEAD,
    byStrategy,
    leadingStrategy
  };
}

async function buildHitRateReport() {
  const scans = await readScanHistory();
  const evaluated = [];
  let pendingCount = 0;

  for (const scan of scans) {
    for (const result of scan.results) {
      if (result.outcome) {
        evaluated.push({ strategy: result.strategy || scan.strategy, scannedAt: scan.scannedAt, ...result });
      } else {
        pendingCount += 1;
      }
    }
  }

  const byStrategy = {};
  for (const strategyKey of Object.keys(EVALUATION_HORIZON_DAYS)) {
    byStrategy[strategyKey] = summarize(evaluated.filter((entry) => entry.strategy === strategyKey));
  }

  const byOpportunityRankBucket = {};
  for (const bucket of OPPORTUNITY_RANK_BUCKETS) {
    byOpportunityRankBucket[bucket.label] = summarize(
      evaluated.filter((entry) => findOpportunityRankBucket(entry.opportunityRank) === bucket.label)
    );
  }

  return {
    overall: summarize(evaluated),
    byStrategy,
    byOpportunityRankBucket,
    league: buildLeague(evaluated),
    evaluatedCount: evaluated.length,
    pendingCount
  };
}

async function getStrategyLeague() {
  await evaluateOutcomes();
  const report = await buildHitRateReport();
  return report.league;
}

// Cheaper than getStrategyLeague: reads the league table from already-evaluated history without
// triggering a fresh evaluateOutcomes pass (which fetches current prices for every pending
// result). Used on the hot analyzeMarket path, where that cost isn't worth paying on every scan.
async function getLeagueSnapshot() {
  const report = await buildHitRateReport();
  return report.league;
}

module.exports = {
  recordScan,
  evaluateOutcomes,
  buildHitRateReport,
  getStrategyLeague,
  getLeagueSnapshot
};

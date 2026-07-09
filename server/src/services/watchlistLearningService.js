const { readWatchlistOutcomes } = require('./watchlistOutcomeStore');
const { round } = require('./mathUtils');

// Turns logged gap-and-go outcomes (watchlistOutcomes.json) into a per-candidate "breakout
// likelihood" indicator for the next tomorrow-watchlist, per docs/TESTING_PLAN.md's ask to
// eventually surface "which stocks look likely to break out tomorrow" once enough real
// actual-open-price data has been logged.
//
// Deliberately simple and transparent rather than a black-box model: with only a handful of
// logged outcomes at first, a k-nearest-neighbors lookup on rankScore (which already blends
// dailyChange/volumeRatio/highProximity into one number - see watchlistScoring.js) gives an
// honest "here's what happened to similar-looking candidates before" answer without inventing
// patterns a bigger model would hallucinate from a tiny sample.
const MIN_SAMPLE_SIZE = 5;
const NEIGHBOR_COUNT = 8;

function hasUsableFeatures(entry) {
  return Number.isFinite(entry?.rankScoreAtLog) && Number.isFinite(entry?.gapAccuracyPct);
}

// Pure function so it's easy to unit-test without touching the filesystem - callers that already
// have the outcomes array in hand (e.g. attachBreakoutLikelihood, looping over a whole watchlist)
// pass it in rather than re-reading the store per candidate.
function computeBreakoutLikelihood(candidate, outcomes) {
  const usable = (outcomes || []).filter(hasUsableFeatures);

  if (usable.length < MIN_SAMPLE_SIZE) {
    return {
      sampleSize: usable.length,
      minSampleSize: MIN_SAMPLE_SIZE,
      positiveGapRatePct: null,
      avgGapPct: null
    };
  }

  const candidateRankScore = Number(candidate?.rankScore) || 0;
  const neighbors = [...usable]
    .sort((left, right) => Math.abs(left.rankScoreAtLog - candidateRankScore) - Math.abs(right.rankScoreAtLog - candidateRankScore))
    .slice(0, Math.min(NEIGHBOR_COUNT, usable.length));

  const positiveCount = neighbors.filter((entry) => entry.gapAccuracyPct > 0).length;
  const avgGapPct = neighbors.reduce((sum, entry) => sum + entry.gapAccuracyPct, 0) / neighbors.length;

  return {
    sampleSize: neighbors.length,
    minSampleSize: MIN_SAMPLE_SIZE,
    positiveGapRatePct: round((positiveCount / neighbors.length) * 100, 0),
    avgGapPct: round(avgGapPct, 2)
  };
}

// Reads the outcomes store once and attaches a breakoutLikelihood field to every watchlist item,
// so GET /api/watchlist/tomorrow can expose it without the cached watchlist itself needing to
// know about outcomes (this stays a read-time enrichment, same as excessReturnPct in
// portfolioService.js, so the cache never goes stale as new outcomes get logged).
async function attachBreakoutLikelihood(watchlist) {
  const outcomes = await readWatchlistOutcomes();
  return (watchlist || []).map((item) => ({
    ...item,
    breakoutLikelihood: computeBreakoutLikelihood(item, outcomes)
  }));
}

module.exports = {
  MIN_SAMPLE_SIZE,
  computeBreakoutLikelihood,
  attachBreakoutLikelihood
};

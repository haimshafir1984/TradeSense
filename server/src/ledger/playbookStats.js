// Computes per-playbook statistics, strictly split by evidence source (docs/SPEC_V2_ARCHITECTURE.md
// §5.7/§5.8), and the four-rung status a playbook has earned. §1 rule 2 / §11 criterion 3: forward
// and backfill numbers are never pooled into one figure, anywhere.
const { average, median, round } = require('../services/mathUtils');
const ledgerStore = require('./ledgerStore');

// §5.8's ladder thresholds.
const BACKTESTED_MIN_HOLDOUT_N = 100;
const PROVISIONAL_MIN_FORWARD_N = 10;
const ACTIVE_MIN_FORWARD_N = 30;
const CONTRADICTION_HIT_RATE_DELTA_PP = 15;

// n / hitRatePct / avgR / medianR / avgMaePct / profitFactor for one bucket of closed trades.
// Everything is null (not 0) when there are no resolved entries yet - a stat with n=0 must never
// look like "0% hit rate", which would misrepresent "no data" as "a measured failure".
function computeStatsForEntries(entries) {
  const resolved = (entries || []).filter(
    (entry) => entry.outcome && entry.outcome.exitReason !== 'open' && Number.isFinite(entry.outcome.rMultiple)
  );
  const n = resolved.length;

  if (n === 0) {
    return { n: 0, hitRatePct: null, avgR: null, medianR: null, avgMaePct: null, profitFactor: null };
  }

  const rValues = resolved.map((entry) => entry.outcome.rMultiple);
  const wins = rValues.filter((r) => r > 0);
  const grossWin = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((sum, r) => sum + r, 0));
  const maeValues = resolved.map((entry) => entry.outcome.maePct).filter(Number.isFinite);

  return {
    n,
    hitRatePct: round((wins.length / n) * 100, 1),
    avgR: round(average(rValues), 2),
    medianR: round(median(rValues), 2),
    avgMaePct: maeValues.length ? round(average(maeValues), 2) : null,
    // null (not Infinity - unserializable in JSON) when there have been no losing trades yet.
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null
  };
}

// forward stats, plus backfill split further into in_sample/holdout (§5.8's chronological split -
// the holdout half is the only backfill evidence that counts toward the ladder; in_sample is where
// calibration would happen, never evidence of anything on its own).
function computePlaybookStats(entries, playbookKey) {
  const playbookEntries = (entries || []).filter((entry) => entry.playbook === playbookKey);

  const forward = computeStatsForEntries(playbookEntries.filter((entry) => entry.source === 'forward'));
  const backfillEntries = playbookEntries.filter((entry) => entry.source === 'backfill');

  return {
    forward,
    backfill: {
      inSample: computeStatsForEntries(backfillEntries.filter((entry) => entry.period === 'in_sample')),
      holdout: computeStatsForEntries(backfillEntries.filter((entry) => entry.period === 'holdout'))
    }
  };
}

// The four-rung ladder (§5.8). Deliberately conservative at every step - "backtested" requires
// surviving the untouched holdout window, not just the in-sample half; "provisional" requires
// forward results that don't contradict the backtest; "active" requires real forward evidence with
// no path around the 30-trade floor (§11 criterion 4).
function determineStatus(stats) {
  const holdout = stats.backfill.holdout;
  const isBacktested = holdout.n >= BACKTESTED_MIN_HOLDOUT_N && Number.isFinite(holdout.avgR) && holdout.avgR > 0;

  if (!isBacktested) {
    return 'hypothesis';
  }

  const forward = stats.forward;

  if (forward.n >= ACTIVE_MIN_FORWARD_N) {
    return 'active';
  }

  if (forward.n >= PROVISIONAL_MIN_FORWARD_N) {
    const hitRateDelta = Math.abs((forward.hitRatePct ?? 0) - (holdout.hitRatePct ?? 0));
    const notContradicting = hitRateDelta <= CONTRADICTION_HIT_RATE_DELTA_PP && Number.isFinite(forward.avgR) && forward.avgR >= 0;

    if (notContradicting) {
      return 'provisional';
    }
  }

  return 'backtested';
}

async function getPlaybookStatus(playbookKey) {
  const entries = await ledgerStore.readEntries();
  const stats = computePlaybookStats(entries, playbookKey);
  return { stats, status: determineStatus(stats) };
}

module.exports = {
  computeStatsForEntries,
  computePlaybookStats,
  determineStatus,
  getPlaybookStatus
};

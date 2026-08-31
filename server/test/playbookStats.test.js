const test = require('node:test');
const assert = require('node:assert/strict');

const { computeStatsForEntries, computePlaybookStats, determineStatus } = require('../src/ledger/playbookStats');

function closedEntry({ playbook = 'pead_drift', source = 'forward', period = null, rMultiple, maePct = -2, exitReason = 'target' } = {}) {
  return {
    playbook,
    source,
    period,
    outcome: { exitReason, returnPct: {}, mfePct: 5, maePct, rMultiple }
  };
}

function openEntry({ playbook = 'pead_drift', source = 'forward' } = {}) {
  return { playbook, source, outcome: { exitReason: 'open', returnPct: {}, mfePct: null, maePct: null, rMultiple: null } };
}

test('computeStatsForEntries returns all-null (not zero) stats when there are no resolved entries', () => {
  const stats = computeStatsForEntries([openEntry(), { playbook: 'x', source: 'forward', outcome: null }]);

  assert.equal(stats.n, 0);
  assert.equal(stats.hitRatePct, null);
  assert.equal(stats.avgR, null);
  assert.equal(stats.profitFactor, null);
});

test('computeStatsForEntries computes hitRate/avgR/medianR/profitFactor correctly on a known sample', () => {
  const entries = [
    closedEntry({ rMultiple: 3 }),
    closedEntry({ rMultiple: 3 }),
    closedEntry({ rMultiple: -1, exitReason: 'stop' }),
    closedEntry({ rMultiple: -1, exitReason: 'stop' })
  ];

  const stats = computeStatsForEntries(entries);

  assert.equal(stats.n, 4);
  assert.equal(stats.hitRatePct, 50);
  assert.equal(stats.avgR, 1); // (3+3-1-1)/4
  assert.equal(stats.medianR, 1); // sorted [-1,-1,3,3] -> avg of middle two = 1
  assert.equal(stats.profitFactor, 3); // grossWin=6, grossLoss=2 -> 3
});

test('profitFactor is null (not Infinity) when there have been no losing trades', () => {
  const stats = computeStatsForEntries([closedEntry({ rMultiple: 3 }), closedEntry({ rMultiple: 2 })]);
  assert.equal(stats.profitFactor, null);
});

test('computePlaybookStats splits by source, and backfill further by in_sample/holdout, without mixing them', () => {
  const entries = [
    closedEntry({ source: 'forward', rMultiple: 3 }),
    closedEntry({ source: 'backfill', period: 'in_sample', rMultiple: 5 }),
    closedEntry({ source: 'backfill', period: 'holdout', rMultiple: 1 }),
    closedEntry({ source: 'backfill', period: 'holdout', rMultiple: -1, exitReason: 'stop' }),
    closedEntry({ playbook: 'other_playbook', source: 'forward', rMultiple: 99 }) // must not leak in
  ];

  const stats = computePlaybookStats(entries, 'pead_drift');

  assert.equal(stats.forward.n, 1);
  assert.equal(stats.forward.avgR, 3);
  assert.equal(stats.backfill.inSample.n, 1);
  assert.equal(stats.backfill.inSample.avgR, 5);
  assert.equal(stats.backfill.holdout.n, 2);
  assert.equal(stats.backfill.holdout.avgR, 0); // (1-1)/2
});

test('determineStatus: hypothesis when holdout backfill has fewer than 100 trades', () => {
  const stats = {
    forward: { n: 0, hitRatePct: null, avgR: null },
    backfill: { inSample: { n: 200 }, holdout: { n: 50, avgR: 0.5, hitRatePct: 60 } }
  };
  assert.equal(determineStatus(stats), 'hypothesis');
});

test('determineStatus: hypothesis even with 100+ holdout trades if avgR is not positive (failed holdout)', () => {
  const stats = {
    forward: { n: 0, hitRatePct: null, avgR: null },
    backfill: { inSample: { n: 200 }, holdout: { n: 150, avgR: -0.2, hitRatePct: 40 } }
  };
  assert.equal(determineStatus(stats), 'hypothesis');
});

test('determineStatus: backtested once holdout survives, with too little forward data for provisional', () => {
  const stats = {
    forward: { n: 3, hitRatePct: 60, avgR: 0.5 },
    backfill: { inSample: { n: 200 }, holdout: { n: 120, avgR: 0.4, hitRatePct: 55 } }
  };
  assert.equal(determineStatus(stats), 'backtested');
});

test('determineStatus: provisional once forward evidence exists and does not contradict the backtest', () => {
  const stats = {
    forward: { n: 12, hitRatePct: 58, avgR: 0.3 },
    backfill: { inSample: { n: 200 }, holdout: { n: 120, avgR: 0.4, hitRatePct: 55 } }
  };
  assert.equal(determineStatus(stats), 'provisional');
});

test('determineStatus: stays backtested (does not promote) when forward hit rate contradicts the backtest by >15pp', () => {
  const stats = {
    forward: { n: 12, hitRatePct: 20, avgR: 0.1 }, // 55 - 20 = 35pp gap
    backfill: { inSample: { n: 200 }, holdout: { n: 120, avgR: 0.4, hitRatePct: 55 } }
  };
  assert.equal(determineStatus(stats), 'backtested');
});

test('determineStatus: stays backtested when forward avgR has turned negative, even with enough trades', () => {
  const stats = {
    forward: { n: 15, hitRatePct: 50, avgR: -0.3 },
    backfill: { inSample: { n: 200 }, holdout: { n: 120, avgR: 0.4, hitRatePct: 55 } }
  };
  assert.equal(determineStatus(stats), 'backtested');
});

test('determineStatus: active once 30+ forward trades exist, regardless of the provisional contradiction check', () => {
  const stats = {
    forward: { n: 30, hitRatePct: 20, avgR: -0.1 },
    backfill: { inSample: { n: 200 }, holdout: { n: 120, avgR: 0.4, hitRatePct: 55 } }
  };
  assert.equal(determineStatus(stats), 'active');
});

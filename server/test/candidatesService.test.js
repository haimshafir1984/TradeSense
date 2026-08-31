const test = require('node:test');
const assert = require('node:assert/strict');

function freshServices() {
  delete require.cache[require.resolve('../src/pipeline/runScan')];
  delete require.cache[require.resolve('../src/ledger/playbookStats')];
  delete require.cache[require.resolve('../src/ledger/ledgerStore')];
  delete require.cache[require.resolve('../src/pipeline/candidatesService')];
  return {
    runScanModule: require('../src/pipeline/runScan'),
    playbookStats: require('../src/ledger/playbookStats'),
    ledgerStore: require('../src/ledger/ledgerStore'),
    candidatesService: require('../src/pipeline/candidatesService')
  };
}

const FAKE_REGIME = { state: 'neutral', spyAboveMa200: true, realizedVol20d: 0.01, blockedTiers: [] };

function eligibleStock(overrides = {}) {
  return {
    symbol: 'RVRS',
    companyName: 'Reversal Co',
    price: 82,
    atr14: 3,
    ma20: 90,
    ma200: 75,
    rsi14: 25,
    return5d: -12,
    rvol: 2.5,
    rvolBasis: 'daily',
    marketCap: 5000000000, // within balanced's 2B-200B range
    catalyst: null,
    ...overrides
  };
}

function fakeScan(shortlist, overrides = {}) {
  return {
    generatedAt: '2026-01-01T00:00:00Z',
    exchange: 'NASDAQ',
    shortlist,
    regime: FAKE_REGIME,
    diagnostics: { universeCount: 10, afterLiquidityGate: 5, afterSelection: shortlist.length },
    warnings: [],
    ...overrides
  };
}

function stubActiveStatus(playbookStats, statusByKey = {}) {
  playbookStats.getPlaybookStatus = async (key) => ({
    status: statusByKey[key] || 'active',
    stats: { forward: { n: 0 }, backfill: { inSample: { n: 0 }, holdout: { n: 0 } } }
  });
}

test('an unknown risk tier returns an explicit warning and no candidates', async () => {
  const { candidatesService } = freshServices();
  const result = await candidatesService.getCandidates({ riskTier: 'yolo' });

  assert.deepEqual(result.candidates, []);
  assert.match(result.warnings[0], /לא מוכרת/);
});

test('a playbook not allowed on the requested tier returns an explicit warning', async () => {
  const { candidatesService } = freshServices();
  const result = await candidatesService.getCandidates({ riskTier: 'balanced', playbook: 'opening_range_breakout' });

  assert.deepEqual(result.candidates, []);
  assert.match(result.warnings[0], /אינו זמין/);
});

test('when the regime blocks the requested tier, returns no candidates with an explanatory warning', async () => {
  const { runScanModule, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock()], { regime: { ...FAKE_REGIME, state: 'risk_off', blockedTiers: ['aggressive'] } });

  const result = await candidatesService.getCandidates({ riskTier: 'aggressive' });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.stage, 'regime');
});

test('when runScan itself dead-ends, its diagnostics/warnings pass through unchanged', async () => {
  const { runScanModule, candidatesService } = freshServices();
  runScanModule.runScan = async () => ({
    generatedAt: '2026-01-01T00:00:00Z',
    exchange: 'NASDAQ',
    shortlist: [],
    regime: null,
    diagnostics: { stage: 'universe' },
    warnings: ['לא נמצא universe שמור']
  });

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.stage, 'universe');
});

test('a full happy path: eligible stock produces a candidate and is logged to the ledger as source: forward', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock()]);
  stubActiveStatus(playbookStats);

  let loggedEntry = null;
  ledgerStore.appendEntry = async (entry) => {
    loggedEntry = entry;
    return { id: 'x', ...entry };
  };

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.ticker, 'RVRS');
  assert.equal(candidate.playbook.key, 'short_term_reversal');
  assert.equal(candidate.playbook.status, 'active');
  assert.equal(candidate.plan.valid, true);
  assert.deepEqual(candidate.warnings, []); // active status carries no warning

  assert.ok(loggedEntry);
  assert.equal(loggedEntry.source, 'forward');
  assert.equal(loggedEntry.ticker, 'RVRS');
  assert.equal(loggedEntry.playbook, 'short_term_reversal');
});

test('a stock outside the tier\'s market-cap range is excluded and counted in diagnostics, not evaluated by any playbook', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock({ marketCap: 100000000 })]); // way below conservative's 10B floor
  stubActiveStatus(playbookStats);
  let ledgerCalled = false;
  ledgerStore.appendEntry = async () => {
    ledgerCalled = true;
  };

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.marketCapRejectedSample.length, 1);
  assert.equal(ledgerCalled, false);
});

test('an ineligible stock (fails the playbook gate) is counted in diagnostics, not logged', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  // balanced allows pead_drift + gap_continuation + short_term_reversal - this stock fails all
  // three gates (no catalyst, not oversold), so every playbook rejects it independently.
  runScanModule.runScan = async () => fakeScan([eligibleStock({ rsi14: 60 })]);
  stubActiveStatus(playbookStats);
  let ledgerCalled = false;
  ledgerStore.appendEntry = async () => {
    ledgerCalled = true;
  };

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.playbookRejectedSample.length, 3);
  assert.ok(result.diagnostics.playbookRejectedSample.every((rejection) => rejection.symbol === 'RVRS' && rejection.reason));
  assert.equal(ledgerCalled, false);
});

test('a hypothesis-status playbook carries the mandatory "do not trade" warning on every candidate it produces', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock()]);
  stubActiveStatus(playbookStats, { short_term_reversal: 'hypothesis' });
  ledgerStore.appendEntry = async () => {};

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].warnings[0], /רעיון בלבד/);
});

test('a provisional playbook halves the resolved accountRiskUsd before sizing the plan', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock()]);
  stubActiveStatus(playbookStats, { short_term_reversal: 'provisional' });
  ledgerStore.appendEntry = async () => {};

  const result = await candidatesService.getCandidates({ riskTier: 'balanced', accountRiskUsd: 200 });

  // stopDistance for eligibleStock() = 1.5 * atr14(3) = 4.5 -> shares = floor(100/4.5) = 22
  assert.equal(result.candidates[0].plan.sizing.riskUsd <= 100, true);
});

test('a hypothesis-status playbook never gets a computed position size, and warns why', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () => fakeScan([eligibleStock()]);
  stubActiveStatus(playbookStats, { short_term_reversal: 'hypothesis' });
  ledgerStore.appendEntry = async () => {};

  const result = await candidatesService.getCandidates({ riskTier: 'balanced', accountRiskUsd: 200 });

  assert.equal(result.candidates[0].plan.sizing, null);
  assert.ok(result.candidates[0].warnings.some((warning) => warning.includes('גודל פוזיציה')));
});

test('every candidate carries a plain-language catalyst description', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  runScanModule.runScan = async () =>
    fakeScan([
      eligibleStock({
        catalyst: { kind: 'earnings_surprise', earningsSurprisePct: 12.3, daysSinceEarnings: 1, confidence: 'high' }
      })
    ]);
  stubActiveStatus(playbookStats);
  ledgerStore.appendEntry = async () => {};

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.match(result.candidates[0].catalyst.detail, /הפתעת רווחים/);
});

test('candidates are sorted by conviction descending', async () => {
  const { runScanModule, playbookStats, ledgerStore, candidatesService } = freshServices();
  const weak = eligibleStock({ symbol: 'WEAK', return5d: -8.1, rsi14: 29.9, rvol: 2.01 });
  const strong = eligibleStock({ symbol: 'STRONG', return5d: -25, rsi14: 10, rvol: 6 });
  runScanModule.runScan = async () => fakeScan([weak, strong]);
  stubActiveStatus(playbookStats);
  ledgerStore.appendEntry = async () => {};

  const result = await candidatesService.getCandidates({ riskTier: 'balanced' });

  assert.equal(result.candidates[0].ticker, 'STRONG');
  assert.ok(result.candidates[0].conviction >= result.candidates[1].conviction);
});

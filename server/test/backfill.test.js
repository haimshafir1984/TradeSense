const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSplitBoundaries,
  periodForDate,
  reconstructPeadCatalyst,
  runBackfillForSymbol,
  renderReport,
  SUPPORTED_PLAYBOOK_KEYS
} = require('../src/ledger/backfill');
const shortTermReversal = require('../src/playbooks/shortTermReversal');
const peadDrift = require('../src/playbooks/peadDrift');

test('computeSplitBoundaries: in-sample starts 24 months back, holdout starts 6 months back', () => {
  const now = new Date('2026-08-15T00:00:00Z');
  const boundaries = computeSplitBoundaries(now);

  assert.equal(boundaries.inSampleStart.toISOString().slice(0, 10), '2024-08-15');
  assert.equal(boundaries.holdoutStart.toISOString().slice(0, 10), '2026-02-15');
});

test('periodForDate classifies a date correctly into in_sample vs holdout vs out-of-window', () => {
  const boundaries = computeSplitBoundaries(new Date('2026-08-31T00:00:00Z'));

  assert.equal(periodForDate(new Date('2025-01-01'), boundaries), 'in_sample');
  assert.equal(periodForDate(new Date('2026-06-01'), boundaries), 'holdout');
  assert.equal(periodForDate(new Date('2020-01-01'), boundaries), null);
});

test('reconstructPeadCatalyst only uses surprises known on or before the decision day (anti-lookahead)', () => {
  const surprises = [
    { period: '2026-01-10', actual: 1, estimate: 0.8, surprisePercent: 25 },
    { period: '2026-06-15', actual: 1, estimate: 0.9, surprisePercent: 11 } // future relative to decision day below
  ];

  const catalyst = reconstructPeadCatalyst(surprises, new Date('2026-01-12'));

  assert.equal(catalyst.earningsSurprisePct, 25); // must NOT see the June surprise
  assert.equal(catalyst.daysSinceEarnings, 2);
});

test('reconstructPeadCatalyst returns null when no surprise is known yet as of that day', () => {
  const surprises = [{ period: '2026-06-15', actual: 1, estimate: 0.9, surprisePercent: 11 }];
  assert.equal(reconstructPeadCatalyst(surprises, new Date('2026-01-01')), null);
  assert.equal(reconstructPeadCatalyst([], new Date('2026-01-01')), null);
  assert.equal(reconstructPeadCatalyst(null, new Date('2026-01-01')), null);
});

// Builds a bar series: `flatCount` bars of a steady uptrend (keeps MA200 well below the eventual
// peak, so price stays above it even after the drop below), then a sharp 5-day drop on elevated
// volume (satisfying short_term_reversal's oversold/rvol trigger), then a strong recovery (so the
// trade resolves as a target hit rather than staying open). Verified empirically to trigger every
// gate (price>MA200, return5d<=-8%, RSI14<30, rvol>=2) at the end of the drop.
function makeReversalSetupBars({ flatCount = 300, startPrice = 50 } = {}) {
  const bars = [];
  let price = startPrice;
  const startDate = new Date('2023-01-01T00:00:00Z');

  function pushBar(o, h, l, c, v, dayOffset) {
    const t = new Date(startDate.getTime() + dayOffset * 24 * 60 * 60 * 1000).toISOString();
    bars.push({ t, o, h, l, c, v });
  }

  for (let i = 0; i < flatCount; i += 1) {
    pushBar(price, price + 0.3, price - 0.3, price + 0.3, 5000000, i);
    price += 0.3;
  }
  // Sharp 5-day drop (~9.6%) on elevated volume - triggers the oversold/rvol gate.
  for (let i = 0; i < 5; i += 1) {
    price *= 0.98;
    pushBar(price / 0.98, price / 0.98, price * 0.99, price, 28000000, flatCount + i);
  }
  // Strong recovery so the target gets hit.
  for (let i = 0; i < 15; i += 1) {
    price *= 1.03;
    pushBar(price / 1.03, price * 1.02, price / 1.03, price, 5000000, flatCount + 5 + i);
  }

  return bars;
}

test('runBackfillForSymbol finds and resolves a real short_term_reversal setup end-to-end', () => {
  const bars = makeReversalSetupBars();
  const boundaries = { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2020-01-01') };

  const entries = runBackfillForSymbol({
    symbol: 'TEST',
    bars,
    playbooks: [shortTermReversal],
    surprises: null,
    boundaries
  });

  assert.ok(entries.length > 0, 'expected at least one eligible+resolved trade');
  const entry = entries[0];
  assert.equal(entry.ticker, 'TEST');
  assert.equal(entry.playbook, 'short_term_reversal');
  assert.equal(entry.source, 'backfill');
  assert.ok(entry.outcome && entry.outcome.exitReason !== 'open');
  assert.ok(['in_sample', 'holdout'].includes(entry.period));
});

test('runBackfillForSymbol never records a trade with an unresolvable (still-open) outcome', () => {
  // Same setup bars but cut off right after the eligible day, before the recovery resolves anything.
  const fullBars = makeReversalSetupBars();
  const cutBars = fullBars.slice(0, 306); // just past the drop, before the long recovery run
  const boundaries = { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2020-01-01') };

  const entries = runBackfillForSymbol({
    symbol: 'TEST',
    bars: cutBars,
    playbooks: [shortTermReversal],
    surprises: null,
    boundaries
  });

  assert.ok(entries.every((entry) => entry.outcome.exitReason !== 'open'));
});

test('runBackfillForSymbol skips symbols with fewer than MIN_HISTORY_BARS bars entirely', () => {
  const entries = runBackfillForSymbol({
    symbol: 'NEW',
    bars: makeReversalSetupBars({ flatCount: 50 }),
    playbooks: [shortTermReversal],
    surprises: null,
    boundaries: { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2020-01-01') }
  });

  assert.deepEqual(entries, []);
});

test('runBackfillForSymbol respects the chronological window - decisions before in-sample start are skipped', () => {
  const bars = makeReversalSetupBars();
  // Boundaries set so the whole series predates the window entirely.
  const boundaries = { inSampleStart: new Date('2030-01-01'), holdoutStart: new Date('2030-06-01') };

  const entries = runBackfillForSymbol({ symbol: 'TEST', bars, playbooks: [shortTermReversal], surprises: null, boundaries });

  assert.deepEqual(entries, []);
});

test('runBackfillForSymbol tags entries correctly as in_sample vs holdout by decision date', () => {
  const bars = makeReversalSetupBars();
  // Force every decision date in this series to land in "holdout" by setting holdoutStart far back.
  const holdoutBoundaries = { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2020-01-01') };
  const holdoutEntries = runBackfillForSymbol({ symbol: 'TEST', bars, playbooks: [shortTermReversal], surprises: null, boundaries: holdoutBoundaries });
  assert.ok(holdoutEntries.length > 0);
  assert.ok(holdoutEntries.every((entry) => entry.period === 'holdout'));

  // Force everything into "in_sample" by setting holdoutStart in the far future.
  const inSampleBoundaries = { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2099-01-01') };
  const inSampleEntries = runBackfillForSymbol({ symbol: 'TEST', bars, playbooks: [shortTermReversal], surprises: null, boundaries: inSampleBoundaries });
  assert.ok(inSampleEntries.length > 0);
  assert.ok(inSampleEntries.every((entry) => entry.period === 'in_sample'));
});

test('pead_drift never gets evaluated without earnings history - reconstructPeadCatalyst path only fires when surprises is passed', () => {
  const bars = makeReversalSetupBars(); // no earnings-shaped move here, just proves no crash/false-positive
  const entries = runBackfillForSymbol({
    symbol: 'TEST',
    bars,
    playbooks: [peadDrift],
    surprises: null,
    boundaries: { inSampleStart: new Date('2020-01-01'), holdoutStart: new Date('2020-01-01') }
  });

  assert.deepEqual(entries, []); // no catalyst reconstructed -> pead_drift never eligible
});

test('renderReport includes the mandatory survivorship-bias warning and skipped-playbook disclosure', () => {
  const report = renderReport({
    written: [],
    skippedKeys: ['gap_continuation'],
    universeCount: 300,
    symbolsScanned: 150,
    boundaries: computeSplitBoundaries(),
    statsByPlaybook: {
      pead_drift: {
        status: 'hypothesis',
        stats: {
          forward: { n: 0, hitRatePct: null, avgR: null, medianR: null, avgMaePct: null, profitFactor: null },
          backfill: {
            inSample: { n: 0, hitRatePct: null, avgR: null, medianR: null, avgMaePct: null, profitFactor: null },
            holdout: { n: 0, hitRatePct: null, avgR: null, medianR: null, avgMaePct: null, profitFactor: null }
          }
        }
      }
    },
    exchange: 'NASDAQ',
    months: 24
  });

  assert.match(report, /הטיית שרידות/);
  assert.match(report, /gap_continuation/);
  assert.match(report, /backtested/); // ceiling explanation mentions the status name
});

test('SUPPORTED_PLAYBOOK_KEYS matches exactly the two playbooks that don\'t need historical catalyst data', () => {
  assert.deepEqual(SUPPORTED_PLAYBOOK_KEYS, ['pead_drift', 'short_term_reversal']);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveOutcomeFromBars, resolveAll } = require('../src/ledger/outcomeResolver');

function longPlan({ entry = 100, stop = 90, target = 130, timeStopDays = 10, rMultiple = 3 } = {}) {
  return {
    valid: true,
    entry: { price: entry, type: 'market' },
    stop: { price: stop, distancePct: 10, distanceR: 1, basis: 'atr14 × 1' },
    target: { price: target, rMultiple, gainPct: 30 },
    timeStopDays
  };
}

function bar(day, { o = 100, h = 101, l = 99, c = 100 } = {}) {
  return { t: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, o, h, l, c };
}

test('resolves target hit and returns rMultiple equal to the plan\'s target rMultiple', () => {
  const bars = [bar(1, { h: 105, l: 99, c: 104 }), bar(2, { h: 135, l: 128, c: 132 })]; // day 2 hits target=130
  const outcome = resolveOutcomeFromBars(longPlan(), bars);

  assert.equal(outcome.exitReason, 'target');
  assert.equal(outcome.rMultiple, 3);
  assert.equal(outcome.resolvedAt !== null, true);
});

test('resolves stop hit and returns rMultiple of exactly -1', () => {
  const bars = [bar(1, { h: 101, l: 88, c: 89 })]; // day 1 hits stop=90
  const outcome = resolveOutcomeFromBars(longPlan(), bars);

  assert.equal(outcome.exitReason, 'stop');
  assert.equal(outcome.rMultiple, -1);
});

test('when a single bar touches both stop and target, the stop wins (conservative tie-break)', () => {
  const bars = [bar(1, { h: 140, l: 80, c: 100 })]; // touches both stop=90 and target=130
  const outcome = resolveOutcomeFromBars(longPlan(), bars);

  assert.equal(outcome.exitReason, 'stop');
});

test('resolves time_stop when neither is hit within timeStopDays, using that day\'s close', () => {
  const bars = [
    bar(1, { h: 102, l: 99, c: 101 }),
    bar(2, { h: 103, l: 100, c: 102 }),
    bar(3, { h: 104, l: 101, c: 103 })
  ];
  const outcome = resolveOutcomeFromBars(longPlan({ timeStopDays: 3 }), bars);

  assert.equal(outcome.exitReason, 'time_stop');
  // exit price = day 3 close = 103; stop distance = 10 -> rMultiple = (103-100)/10 = 0.3
  assert.equal(outcome.rMultiple, 0.3);
});

test('remains open when fewer bars than timeStopDays have elapsed and nothing was hit', () => {
  const bars = [bar(1, { h: 102, l: 99, c: 101 })];
  const outcome = resolveOutcomeFromBars(longPlan({ timeStopDays: 10 }), bars);

  assert.equal(outcome.exitReason, 'open');
  assert.equal(outcome.resolvedAt, null);
  assert.equal(outcome.rMultiple, null);
});

test('returnPct is computed at every fixed horizon when enough bars exist, null otherwise', () => {
  const bars = Array.from({ length: 25 }, (unused, i) => bar(i + 1, { h: 100 + i, l: 99 + i, c: 100 + i }));
  const outcome = resolveOutcomeFromBars(longPlan({ target: 999999, timeStopDays: 999 }), bars);

  assert.equal(outcome.returnPct.d1, 0); // day1 close=100, entry=100
  assert.ok(outcome.returnPct.d20 > 0);

  const shortBars = bars.slice(0, 2);
  const shortOutcome = resolveOutcomeFromBars(longPlan({ target: 999999, timeStopDays: 999 }), shortBars);
  assert.equal(shortOutcome.returnPct.d5, null);
  assert.equal(shortOutcome.returnPct.d20, null);
});

test('mfePct/maePct capture the best/worst excursion up to the resolution point, not beyond it', () => {
  const bars = [
    bar(1, { h: 110, l: 95, c: 105 }), // mfe so far: +10%, mae: -5%
    bar(2, { h: 135, l: 128, c: 132 }) // day 2 hits target - resolution stops here
  ];
  const outcome = resolveOutcomeFromBars(longPlan(), bars);

  assert.equal(outcome.exitReason, 'target');
  assert.equal(outcome.mfePct, 35); // best high seen = 135 -> +35%
  assert.equal(outcome.maePct, -5); // worst low seen before/at resolution = 95 -> -5%
});

test('an invalid plan or missing bars returns null instead of throwing', () => {
  assert.equal(resolveOutcomeFromBars({ valid: false }, []), null);
  assert.equal(resolveOutcomeFromBars(longPlan(), null), null);
});

test('anti-lookahead: bars appended after the resolution bar never change the outcome', () => {
  const barsToResolution = [bar(1, { h: 105, l: 99, c: 104 }), bar(2, { h: 135, l: 128, c: 132 })];
  const extended = [...barsToResolution, bar(3, { h: 999, l: 1, c: 500 })];

  const a = resolveOutcomeFromBars(longPlan(), barsToResolution);
  const b = resolveOutcomeFromBars(longPlan(), extended);

  assert.equal(a.exitReason, b.exitReason);
  assert.equal(a.rMultiple, b.rMultiple);
  assert.equal(a.mfePct, b.mfePct);
  assert.equal(a.maePct, b.maePct);
});

test('resolveAll is fail-soft: one entry throwing does not stop the others from resolving', async () => {
  delete require.cache[require.resolve('../src/providers/alpacaService')];
  delete require.cache[require.resolve('../src/ledger/ledgerStore')];
  delete require.cache[require.resolve('../src/ledger/outcomeResolver')];

  const alpacaService = require('../src/providers/alpacaService');
  const ledgerStore = require('../src/ledger/ledgerStore');
  const outcomeResolverFresh = require('../src/ledger/outcomeResolver');

  const originalReadUnresolved = ledgerStore.readUnresolvedEntries;
  const originalUpdateOutcome = ledgerStore.updateOutcome;
  const originalGetDailyBars = alpacaService.getDailyBars;

  ledgerStore.readUnresolvedEntries = async () => [
    { id: 'ok', ticker: 'OK', createdAt: '2026-01-01T00:00:00Z', plan: longPlan() },
    { id: 'bad', ticker: 'BAD', createdAt: 'not-a-real-date', plan: longPlan() }
  ];
  alpacaService.getDailyBars = async () => new Map([['OK', [bar(2, { h: 135, l: 128, c: 132 })]]]);
  ledgerStore.updateOutcome = async (id, outcome) => ({ id, outcome });

  const results = await outcomeResolverFresh.resolveAll();

  ledgerStore.readUnresolvedEntries = originalReadUnresolved;
  ledgerStore.updateOutcome = originalUpdateOutcome;
  alpacaService.getDailyBars = originalGetDailyBars;

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'ok');
});

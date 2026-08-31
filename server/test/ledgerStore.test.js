const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshLedgerStore(scratchPath) {
  process.env.LEDGER_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/ledger/ledgerStore')];
  return require('../src/ledger/ledgerStore');
}

function scratchFile() {
  return path.join(os.tmpdir(), `ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(scratchPath) {
  fs.rmSync(scratchPath, { force: true });
  delete process.env.LEDGER_STORE_FILE_PATH;
}

test('readEntries returns an empty array when no file exists yet', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const entries = await ledgerStore.readEntries();

  cleanup(scratchPath);
  assert.deepEqual(entries, []);
});

test('appendEntry persists an entry with a generated id, source, and null outcome', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const entry = await ledgerStore.appendEntry({
    ticker: 'AAPL',
    playbook: 'pead_drift',
    riskTier: 'balanced',
    featuresAtDecision: { price: 100 },
    plan: { valid: true },
    regimeAtDecision: 'neutral',
    source: 'forward'
  });

  const entries = await ledgerStore.readEntries();
  cleanup(scratchPath);

  assert.ok(entry.id);
  assert.equal(entry.source, 'forward');
  assert.equal(entry.outcome, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ticker, 'AAPL');
});

test('appendEntries bulk-writes multiple entries (used by ledger:backfill)', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const created = await ledgerStore.appendEntries([
    { ticker: 'A', playbook: 'pead_drift', source: 'backfill', period: 'in_sample' },
    { ticker: 'B', playbook: 'pead_drift', source: 'backfill', period: 'holdout' }
  ]);

  const entries = await ledgerStore.readEntries();
  cleanup(scratchPath);

  assert.equal(created.length, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].period, 'holdout');
});

test('updateOutcome sets the outcome on the matching entry and leaves others untouched', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const entryA = await ledgerStore.appendEntry({ ticker: 'A', playbook: 'pead_drift', source: 'forward' });
  await ledgerStore.appendEntry({ ticker: 'B', playbook: 'pead_drift', source: 'forward' });

  const outcome = { resolvedAt: '2026-02-01T00:00:00Z', exitReason: 'target', returnPct: {}, mfePct: 5, maePct: -1, rMultiple: 3 };
  await ledgerStore.updateOutcome(entryA.id, outcome);

  const entries = await ledgerStore.readEntries();
  cleanup(scratchPath);

  const updated = entries.find((entry) => entry.id === entryA.id);
  const untouched = entries.find((entry) => entry.ticker === 'B');

  assert.deepEqual(updated.outcome, outcome);
  assert.equal(untouched.outcome, null);
});

test('updateOutcome returns null for an unknown id instead of throwing', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const result = await ledgerStore.updateOutcome('does_not_exist', { exitReason: 'target' });

  cleanup(scratchPath);
  assert.equal(result, null);
});

test('readUnresolvedEntries returns entries with no outcome or an open outcome, excluding closed ones', async () => {
  const scratchPath = scratchFile();
  const ledgerStore = freshLedgerStore(scratchPath);

  const noOutcomeYet = await ledgerStore.appendEntry({ ticker: 'NEW', playbook: 'pead_drift', source: 'forward' });
  const stillOpen = await ledgerStore.appendEntry({ ticker: 'OPEN', playbook: 'pead_drift', source: 'forward' });
  const closed = await ledgerStore.appendEntry({ ticker: 'DONE', playbook: 'pead_drift', source: 'forward' });

  await ledgerStore.updateOutcome(stillOpen.id, { exitReason: 'open', returnPct: {}, mfePct: null, maePct: null, rMultiple: null });
  await ledgerStore.updateOutcome(closed.id, { exitReason: 'target', returnPct: {}, mfePct: 5, maePct: -1, rMultiple: 3 });

  const unresolved = await ledgerStore.readUnresolvedEntries();
  cleanup(scratchPath);

  const tickers = unresolved.map((entry) => entry.ticker);
  assert.ok(tickers.includes('NEW'));
  assert.ok(tickers.includes('OPEN'));
  assert.ok(!tickers.includes('DONE'));
});

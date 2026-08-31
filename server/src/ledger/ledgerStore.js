// Persistence for the ledger (docs/SPEC_V2_ARCHITECTURE.md §5.7) - the core requirement of the
// whole rebuild: every candidate ever shown gets a row here, automatically, and its outcome gets
// filled in from real price data. Without this the system has no way to know if it works.
//
// Same overridable-path pattern as portfolioStore.js/universeStore.js so tests never touch the
// real runtime file.
const fs = require('fs/promises');
const path = require('path');

const ledgerPath = process.env.LEDGER_STORE_FILE_PATH || path.resolve(__dirname, '../data/ledger.json');

async function readEntries() {
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeEntries(entries) {
  const normalized = Array.isArray(entries) ? entries : [];
  await fs.writeFile(ledgerPath, JSON.stringify({ entries: normalized }, null, 2));
  return normalized;
}

function createId() {
  return `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Appends one entry and returns it (with its generated id). `source` is the single most important
// field on the row (§5.7): 'forward' (a real candidate shown today), 'backfill' (ledger:backfill's
// historical reconstruction), or 'shadow' (a near-miss that failed exactly one gate - §5.8,
// counted toward nothing, used only to sanity-check where thresholds sit).
async function appendEntry({
  ticker,
  playbook,
  riskTier,
  featuresAtDecision,
  plan,
  regimeAtDecision,
  source,
  createdAt,
  period = null
}) {
  const entries = await readEntries();

  const entry = {
    id: createId(),
    createdAt: createdAt || new Date().toISOString(),
    ticker,
    playbook,
    riskTier: riskTier || null,
    featuresAtDecision: featuresAtDecision || {},
    plan: plan || null,
    regimeAtDecision: regimeAtDecision || null,
    source,
    // Only meaningful for source: 'backfill' - which side of the chronological split (§5.8) this
    // trade came from. null for forward/shadow entries.
    period,
    outcome: null
  };

  entries.push(entry);
  await writeEntries(entries);

  return entry;
}

async function appendEntries(newEntries) {
  const entries = await readEntries();
  const created = (newEntries || []).map((input) => ({
    id: createId(),
    createdAt: input.createdAt || new Date().toISOString(),
    ticker: input.ticker,
    playbook: input.playbook,
    riskTier: input.riskTier || null,
    featuresAtDecision: input.featuresAtDecision || {},
    plan: input.plan || null,
    regimeAtDecision: input.regimeAtDecision || null,
    source: input.source,
    period: input.period || null,
    outcome: null
  }));

  const combined = entries.concat(created);
  await writeEntries(combined);

  return created;
}

async function updateOutcome(id, outcome) {
  const entries = await readEntries();
  const index = entries.findIndex((entry) => entry.id === id);

  if (index === -1) {
    return null;
  }

  entries[index] = { ...entries[index], outcome };
  await writeEntries(entries);

  return entries[index];
}

// Entries whose outcome hasn't been resolved yet, or whose outcome is still 'open' (still within
// its horizon, no exit condition hit yet) - what outcomeResolver.js processes each run.
async function readUnresolvedEntries() {
  const entries = await readEntries();
  return entries.filter((entry) => !entry.outcome || entry.outcome.exitReason === 'open');
}

module.exports = {
  readEntries,
  writeEntries,
  appendEntry,
  appendEntries,
  updateOutcome,
  readUnresolvedEntries
};

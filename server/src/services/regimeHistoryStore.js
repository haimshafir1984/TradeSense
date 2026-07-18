// Daily regime snapshots per exchange (docs/SPEC_SHORT_TERM_UPGRADE.md step 6): the regime
// computed in marketRegimeService.js is a same-day snapshot of 3 ETFs + universe breadth, which
// can flip between two scans on the same day. This store lets the app smooth over the last few
// calendar days instead, without changing assessMarketRegime's own (still synchronous, still
// pure) logic. Same lightweight JSON-file pattern as scanHistoryStore.js/watchlistStore.js.
const fs = require('fs/promises');
const path = require('path');

const regimeHistoryPath = process.env.REGIME_HISTORY_FILE_PATH || path.resolve(__dirname, '../data/regimeHistory.json');

// Only the last 3 days are ever read (see marketRegimeService#computeSmoothedRegime) - kept a
// little wider on disk so a gap day (e.g. server was down) doesn't immediately lose all history.
const MAX_STORED_DAYS_PER_EXCHANGE = 14;

async function readHistory() {
  try {
    const raw = await fs.readFile(regimeHistoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeHistory(history) {
  await fs.writeFile(regimeHistoryPath, JSON.stringify(history, null, 2));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// At most one entry per calendar day per exchange - a later scan the same day replaces today's
// entry rather than appending a duplicate, so a single volatile intraday reading can't get
// double-counted against a calmer day. Returns the exchange's updated entry list (oldest first).
async function recordRegimeSnapshot(exchange, regime, now = new Date()) {
  const history = await readHistory();
  const entries = Array.isArray(history[exchange]) ? history[exchange] : [];
  const today = dateKey(now);

  const withoutToday = entries.filter((entry) => entry.date !== today);
  withoutToday.push({ date: today, regime });

  const trimmed = withoutToday.sort((left, right) => (left.date < right.date ? -1 : 1)).slice(-MAX_STORED_DAYS_PER_EXCHANGE);

  history[exchange] = trimmed;
  await writeHistory(history);
  return trimmed;
}

async function getRecentEntries(exchange) {
  const history = await readHistory();
  return Array.isArray(history[exchange]) ? history[exchange] : [];
}

module.exports = {
  recordRegimeSnapshot,
  getRecentEntries
};

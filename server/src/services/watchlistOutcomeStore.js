const fs = require('fs/promises');
const path = require('path');

// Overridable so tests can point this at a scratch file instead of the real runtime data file
// (same pattern as watchlistStore.js/scanHistoryStore.js).
const watchlistOutcomeStorePath =
  process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH || path.resolve(__dirname, '../data/watchlistOutcomes.json');

// Flat array of outcome records: { id, date, ticker, modelClosePrice, actualOpenPrice,
// gapAccuracyPct, loggedAt }.
async function readWatchlistOutcomes() {
  try {
    const raw = await fs.readFile(watchlistOutcomeStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.outcomes) ? parsed.outcomes : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeWatchlistOutcomes(outcomes) {
  const normalized = Array.isArray(outcomes) ? outcomes : [];
  await fs.writeFile(watchlistOutcomeStorePath, JSON.stringify({ outcomes: normalized }, null, 2));
  return normalized;
}

module.exports = {
  readWatchlistOutcomes,
  writeWatchlistOutcomes
};

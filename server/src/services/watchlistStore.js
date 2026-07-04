const fs = require('fs/promises');
const path = require('path');

// Overridable so tests can point this at a scratch file instead of the real runtime data file.
const watchlistStorePath = process.env.WATCHLIST_STORE_FILE_PATH || path.resolve(__dirname, '../data/watchlistCache.json');

// One cached entry per exchange: { generatedAt, watchlist }.
async function readWatchlistCache() {
  try {
    const raw = await fs.readFile(watchlistStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function writeWatchlistCache(cache) {
  await fs.writeFile(watchlistStorePath, JSON.stringify(cache, null, 2));
}

module.exports = {
  readWatchlistCache,
  writeWatchlistCache
};

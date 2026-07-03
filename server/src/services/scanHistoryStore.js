const fs = require('fs/promises');
const path = require('path');

// Overridable so tests can point this at a scratch file instead of the real runtime data file.
const scanHistoryPath = process.env.SCAN_HISTORY_FILE_PATH || path.resolve(__dirname, '../data/scanHistory.json');

// Keep the file bounded - this is a lightweight JSON store (same pattern as portfolioStore.js),
// not a database. Past this size, oldest scans are dropped on write.
const MAX_STORED_SCANS = 500;

async function readScanHistory() {
  try {
    const raw = await fs.readFile(scanHistoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.scans) ? parsed.scans : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeScanHistory(scans) {
  const normalized = Array.isArray(scans) ? scans.slice(-MAX_STORED_SCANS) : [];
  await fs.writeFile(scanHistoryPath, JSON.stringify({ scans: normalized }, null, 2));
  return normalized;
}

module.exports = {
  readScanHistory,
  writeScanHistory
};

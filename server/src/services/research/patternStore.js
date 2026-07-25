// Disk-backed store for patterns that survived the full anomaly-mining pipeline (discovery +
// holdout gate - docs/SPEC_ANOMALY_MINING.md sections 6.5, 7.1). Same pattern as universeStore.js.
// This is the contract matchAnomalies.js reads: the full run metadata (windows, feed, thresholds)
// plus the surviving patterns' conditions and stats, plus the shared bin `boundaries` needed to
// classify today's data against those exact conditions without recomputing anything.
const fs = require('fs/promises');
const path = require('path');

const patternsStorePath =
  process.env.RESEARCH_PATTERNS_FILE_PATH || path.resolve(__dirname, '../../data/anomalyPatterns.json');

async function writePatterns(entry) {
  await fs.mkdir(path.dirname(patternsStorePath), { recursive: true });
  await fs.writeFile(patternsStorePath, JSON.stringify(entry, null, 2));
}

async function readPatterns() {
  try {
    const raw = await fs.readFile(patternsStorePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

module.exports = {
  writePatterns,
  readPatterns,
  patternsStorePath
};

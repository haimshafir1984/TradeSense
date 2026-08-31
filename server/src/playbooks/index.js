// Playbook registry (docs/SPEC_V2_ARCHITECTURE.md §4/§5.3).
const peadDrift = require('./peadDrift');
const shortTermReversal = require('./shortTermReversal');
const gapContinuation = require('./gapContinuation');
const openingRangeBreakout = require('./openingRangeBreakout');

const ALWAYS_ON_PLAYBOOKS = [peadDrift, shortTermReversal, gapContinuation];

// §11 criterion 10: ORB_ENABLED off must behave exactly as if opening_range_breakout didn't exist
// at all - checked at call time (not cached at module load) so tests and runtime toggles both work
// without needing to bust the require cache. Default off.
function isOrbEnabled() {
  return process.env.ORB_ENABLED === 'true';
}

function listPlaybooks() {
  return isOrbEnabled() ? [...ALWAYS_ON_PLAYBOOKS, openingRangeBreakout] : ALWAYS_ON_PLAYBOOKS;
}

function getPlaybook(key) {
  return listPlaybooks().find((playbook) => playbook.key === key) || null;
}

module.exports = {
  isOrbEnabled,
  getPlaybook,
  listPlaybooks
};

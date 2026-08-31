// Playbook registry (docs/SPEC_V2_ARCHITECTURE.md §4/§5.3). Grows as later phases add
// gap_continuation (phase 5) and opening_range_breakout (phase 9, behind ORB_ENABLED).
const peadDrift = require('./peadDrift');
const shortTermReversal = require('./shortTermReversal');

const PLAYBOOKS = [peadDrift, shortTermReversal];
const PLAYBOOKS_BY_KEY = new Map(PLAYBOOKS.map((playbook) => [playbook.key, playbook]));

function getPlaybook(key) {
  return PLAYBOOKS_BY_KEY.get(key) || null;
}

function listPlaybooks() {
  return PLAYBOOKS;
}

module.exports = {
  PLAYBOOKS,
  getPlaybook,
  listPlaybooks
};

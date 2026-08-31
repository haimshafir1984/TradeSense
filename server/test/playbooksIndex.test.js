const test = require('node:test');
const assert = require('node:assert/strict');

const { PLAYBOOKS, getPlaybook, listPlaybooks } = require('../src/playbooks/index');

test('the registry contains pead_drift and short_term_reversal (phase 4)', () => {
  const keys = PLAYBOOKS.map((playbook) => playbook.key);
  assert.ok(keys.includes('pead_drift'));
  assert.ok(keys.includes('short_term_reversal'));
});

test('getPlaybook returns the matching playbook or null for an unknown key', () => {
  assert.equal(getPlaybook('pead_drift').key, 'pead_drift');
  assert.equal(getPlaybook('does_not_exist'), null);
});

test('listPlaybooks returns the same set as PLAYBOOKS', () => {
  assert.deepEqual(listPlaybooks(), PLAYBOOKS);
});

test('every registered playbook satisfies the §5.3 contract shape', () => {
  for (const playbook of PLAYBOOKS) {
    assert.equal(typeof playbook.key, 'string');
    assert.equal(typeof playbook.label, 'string');
    assert.equal(playbook.status, 'hypothesis'); // every playbook starts here, no exceptions
    assert.ok(['strong', 'moderate', 'weak'].includes(playbook.evidence.strength));
    assert.ok(Array.isArray(playbook.evidence.sources) && playbook.evidence.sources.length > 0);
    assert.ok(typeof playbook.evidence.note === 'string' && playbook.evidence.note.length > 0);
    assert.equal(typeof playbook.horizonDays, 'number');
    assert.ok(Array.isArray(playbook.allowedRiskTiers) && playbook.allowedRiskTiers.length > 0);
    assert.equal(typeof playbook.requiresIntraday, 'boolean');
    assert.equal(typeof playbook.evaluate, 'function');
  }
});

test('every allowedRiskTiers entry is a real tier that actually allows this playbook', () => {
  const { isPlaybookAllowed } = require('../src/risk/riskTiers');
  for (const playbook of PLAYBOOKS) {
    for (const tierKey of playbook.allowedRiskTiers) {
      assert.equal(
        isPlaybookAllowed(tierKey, playbook.key),
        true,
        `${playbook.key} claims tier ${tierKey} but riskTiers.js disagrees`
      );
    }
  }
});

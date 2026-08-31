const test = require('node:test');
const assert = require('node:assert/strict');

function freshIndex() {
  delete require.cache[require.resolve('../src/playbooks/index')];
  return require('../src/playbooks/index');
}

function clearOrbFlag() {
  delete process.env.ORB_ENABLED;
}

test('the registry contains pead_drift, short_term_reversal, and gap_continuation by default', () => {
  clearOrbFlag();
  const { listPlaybooks } = freshIndex();
  const keys = listPlaybooks().map((playbook) => playbook.key);

  assert.ok(keys.includes('pead_drift'));
  assert.ok(keys.includes('short_term_reversal'));
  assert.ok(keys.includes('gap_continuation'));
});

test('opening_range_breakout is absent by default (ORB_ENABLED unset) - §11 criterion 10', () => {
  clearOrbFlag();
  const { listPlaybooks, getPlaybook } = freshIndex();

  assert.ok(!listPlaybooks().some((playbook) => playbook.key === 'opening_range_breakout'));
  assert.equal(getPlaybook('opening_range_breakout'), null);
});

test('opening_range_breakout appears only when ORB_ENABLED is exactly the string "true"', () => {
  const { listPlaybooks, getPlaybook, isOrbEnabled } = freshIndex();

  process.env.ORB_ENABLED = 'yes'; // anything other than the literal string 'true' stays off
  assert.equal(isOrbEnabled(), false);
  assert.equal(getPlaybook('opening_range_breakout'), null);

  process.env.ORB_ENABLED = 'true';
  assert.equal(isOrbEnabled(), true);
  assert.ok(listPlaybooks().some((playbook) => playbook.key === 'opening_range_breakout'));
  assert.equal(getPlaybook('opening_range_breakout').key, 'opening_range_breakout');

  clearOrbFlag();
});

test('getPlaybook returns null for an unknown key', () => {
  clearOrbFlag();
  const { getPlaybook } = freshIndex();
  assert.equal(getPlaybook('does_not_exist'), null);
});

test('every playbook satisfies the §5.3 contract shape, ORB included when enabled', () => {
  process.env.ORB_ENABLED = 'true';
  const { listPlaybooks } = freshIndex();

  for (const playbook of listPlaybooks()) {
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

  clearOrbFlag();
});

test('every allowedRiskTiers entry is a real tier that actually allows this playbook', () => {
  process.env.ORB_ENABLED = 'true';
  const { listPlaybooks } = freshIndex();
  const { isPlaybookAllowed } = require('../src/risk/riskTiers');

  for (const playbook of listPlaybooks()) {
    for (const tierKey of playbook.allowedRiskTiers) {
      assert.equal(
        isPlaybookAllowed(tierKey, playbook.key),
        true,
        `${playbook.key} claims tier ${tierKey} but riskTiers.js disagrees`
      );
    }
  }

  clearOrbFlag();
});

test('opening_range_breakout only claims the aggressive tier', () => {
  process.env.ORB_ENABLED = 'true';
  const { getPlaybook } = freshIndex();

  assert.deepEqual(getPlaybook('opening_range_breakout').allowedRiskTiers, ['aggressive']);

  clearOrbFlag();
});

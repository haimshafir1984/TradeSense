// GET /api/playbooks (docs/SPEC_V2_ARCHITECTURE.md §6/§10 phase 8) - the live, ledger-derived
// status of every playbook, not the static module default.
const express = require('express');
const { listPlaybooks } = require('../playbooks/index');
const { getPlaybookStatus } = require('../ledger/playbookStats');

const router = express.Router();

router.get('/', async (_request, response) => {
  try {
    const playbooks = await Promise.all(
      listPlaybooks().map(async (playbook) => {
        const { status, stats } = await getPlaybookStatus(playbook.key);
        return {
          key: playbook.key,
          label: playbook.label,
          status,
          evidence: playbook.evidence,
          horizonDays: playbook.horizonDays,
          allowedRiskTiers: playbook.allowedRiskTiers,
          requiresIntraday: playbook.requiresIntraday,
          stats
        };
      })
    );

    response.json(playbooks);
  } catch (error) {
    console.warn(`[routes/playbooks] Failed: ${error.message}`);
    response.status(500).json([]);
  }
});

module.exports = router;

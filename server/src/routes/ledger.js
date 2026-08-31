// GET /api/ledger/stats, GET /api/ledger/entries, POST /api/ledger/resolve
// (docs/SPEC_V2_ARCHITECTURE.md §6/§10 phase 8).
const express = require('express');
const ledgerStore = require('../ledger/ledgerStore');
const { computePlaybookStats, determineStatus } = require('../ledger/playbookStats');
const { resolveAll } = require('../ledger/outcomeResolver');
const { listPlaybooks } = require('../playbooks/index');

const router = express.Router();

router.get('/stats', async (request, response) => {
  try {
    const entries = await ledgerStore.readEntries();
    const { playbook: playbookKey } = request.query;

    const keys = playbookKey ? [playbookKey] : listPlaybooks().map((playbook) => playbook.key);
    const statsByPlaybook = {};
    for (const key of keys) {
      const stats = computePlaybookStats(entries, key);
      statsByPlaybook[key] = { stats, status: determineStatus(stats) };
    }

    response.json(statsByPlaybook);
  } catch (error) {
    console.warn(`[routes/ledger] stats failed: ${error.message}`);
    response.status(500).json({});
  }
});

router.get('/entries', async (request, response) => {
  try {
    const limit = Number(request.query.limit) || 100;
    const entries = await ledgerStore.readEntries();
    response.json(entries.slice(-limit).reverse());
  } catch (error) {
    console.warn(`[routes/ledger] entries failed: ${error.message}`);
    response.status(500).json([]);
  }
});

// Manual trigger for outcome resolution (same logic as `npm run ledger:resolve`) - never called
// automatically by anything else in the running app.
router.post('/resolve', async (_request, response) => {
  try {
    const results = await resolveAll();
    const closed = results.filter((entry) => entry.outcome.exitReason !== 'open');
    response.json({ processed: results.length, closed: closed.length });
  } catch (error) {
    console.warn(`[routes/ledger] resolve failed: ${error.message}`);
    response.status(500).json({ processed: 0, closed: 0, error: error.message });
  }
});

module.exports = router;

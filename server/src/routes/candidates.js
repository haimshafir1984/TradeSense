// GET /api/candidates (docs/SPEC_V2_ARCHITECTURE.md §6/§10 phase 8) - replaces the phase-0
// placeholder. Every candidate returned here is also logged to the forward ledger automatically
// by candidatesService (§5.7) - this route does not do that itself.
const express = require('express');
const { getCandidates } = require('../pipeline/candidatesService');

const router = express.Router();

router.get('/', async (request, response) => {
  const { exchange, riskTier, playbook, accountRiskUsd } = request.query;

  try {
    const result = await getCandidates({
      exchange: exchange || 'NASDAQ',
      riskTier: riskTier || 'balanced',
      playbook: playbook || null,
      accountRiskUsd: accountRiskUsd !== undefined ? Number(accountRiskUsd) : null
    });

    response.json(result);
  } catch (error) {
    console.warn(`[routes/candidates] Failed: ${error.message}`);
    response.status(500).json({
      generatedAt: new Date().toISOString(),
      candidates: [],
      diagnostics: { stage: 'error' },
      warnings: ['שגיאה פנימית בסריקה - נסה שוב בעוד רגע']
    });
  }
});

module.exports = router;

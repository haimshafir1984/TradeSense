// Placeholder for the v2 candidates endpoint (docs/SPEC_V2_ARCHITECTURE.md §6). The full pipeline
// (liquidity gate -> catalyst -> selection -> playbooks -> exit engine) is built phase by phase
// per §10; until phase 8 wires the real route, this returns an explicit "not built yet" response
// instead of a bare 404, so a request against the deployed app during the rebuild reads as
// intentional rather than as a broken route.
const express = require('express');

const router = express.Router();

router.get('/', (_request, response) => {
  response.json({
    generatedAt: new Date().toISOString(),
    candidates: [],
    diagnostics: null,
    warnings: ['TradeSense v2 נמצא בבנייה מחדש - מסלול הסריקה עדיין לא מומש. ראו docs/SPEC_V2_ARCHITECTURE.md.']
  });
});

module.exports = router;

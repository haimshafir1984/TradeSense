// Live matching of scan-result tickers against already-mined anomaly patterns
// (docs/SPEC_ANOMALY_MINING.md section 11 - the one deliberate UI/endpoint exception to that
// spec's original CLI-only scope). Never called by /api/analyze itself - the client fires this as
// a separate request once scan results are in hand. Mining (research:mine) still only happens via
// the CLI; this route only reads what a previous mining run already saved.
const express = require('express');
const { isEnabled, matchSymbols } = require('../services/research/anomalyResearchService');

const router = express.Router();

router.get('/status', (_request, response) => {
  response.json({ enabled: isEnabled() });
});

router.post('/check', async (request, response) => {
  if (!isEnabled()) {
    response.json({ available: false, message: 'Anomaly matching is disabled.' });
    return;
  }

  const { tickers } = request.body || {};
  if (!Array.isArray(tickers) || tickers.length === 0) {
    response.status(400).json({ available: false, message: 'tickers נדרש' });
    return;
  }

  const result = await matchSymbols(tickers);
  response.json(result);
});

module.exports = router;

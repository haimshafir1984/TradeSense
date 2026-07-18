const express = require('express');
const { isEnabled, checkStockHistory, checkTheory } = require('../services/vibeTradingService');

const router = express.Router();

// Lets the client hide/disable the buttons entirely when this feature isn't available (e.g. on
// the deployed Render backend, where Vibe-Trading isn't installed) instead of showing a button
// that always fails.
router.get('/status', (_request, response) => {
  response.json({ enabled: isEnabled() });
});

router.post('/stock', async (request, response) => {
  const { ticker, strategy } = request.body || {};
  if (!ticker || !strategy) {
    response.status(400).json({ ok: false, message: 'ticker ו-strategy נדרשים' });
    return;
  }

  const result = await checkStockHistory({ ticker, strategy });
  response.json(result);
});

router.post('/theory', async (request, response) => {
  const { strategy } = request.body || {};
  if (!strategy) {
    response.status(400).json({ ok: false, message: 'strategy נדרש' });
    return;
  }

  const result = await checkTheory({ strategy });
  response.json(result);
});

module.exports = router;

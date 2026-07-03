const express = require('express');
const { evaluateOutcomes, buildHitRateReport } = require('../services/scanHistoryService');

const router = express.Router();

// Evaluates any scans that have reached their horizon, then returns the current hit-rate report.
// Safe to call repeatedly (e.g. on a schedule or on page load) - evaluation is idempotent per result.
router.get('/outcomes', async (_request, response) => {
  try {
    await evaluateOutcomes();
    const report = await buildHitRateReport();
    response.json(report);
  } catch (error) {
    console.error('Scan history outcome evaluation failed', error);
    response.status(500).json({
      message: 'הערכת תוצאות הסריקות נכשלה'
    });
  }
});

module.exports = router;

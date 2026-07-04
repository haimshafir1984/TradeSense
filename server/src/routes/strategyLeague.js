const express = require('express');
const { getStrategyLeague } = require('../services/scanHistoryService');

const router = express.Router();

// Evaluates any scans that have reached their horizon, then returns which strategy is actually
// winning (by measured excess return vs SPY) over the trailing window - not which one a person
// picked. See docs/LOGIC_IMPROVEMENTS.md - Strategy League.
router.get('/', async (_request, response) => {
  try {
    const league = await getStrategyLeague();
    response.json(league);
  } catch (error) {
    console.error('Strategy league lookup failed', error);
    response.status(500).json({
      message: 'טעינת ליגת האסטרטגיות נכשלה'
    });
  }
});

module.exports = router;

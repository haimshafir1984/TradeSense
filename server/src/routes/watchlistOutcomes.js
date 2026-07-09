const express = require('express');
const { logActualOpen, getOutcomesForDate } = require('../services/watchlistOutcomeService');

const router = express.Router();

router.post('/', async (request, response) => {
  try {
    const record = await logActualOpen(request.body);
    response.status(201).json(record);
  } catch (error) {
    response.status(400).json({ message: error.message || 'שמירת מחיר הפתיחה בפועל נכשלה' });
  }
});

router.get('/', async (request, response) => {
  try {
    const date = request.query.date;
    const outcomesByTicker = await getOutcomesForDate(date);
    response.json({ date, outcomes: Object.fromEntries(outcomesByTicker) });
  } catch (error) {
    console.error('Watchlist outcomes request failed', error);
    response.status(500).json({ message: 'טעינת תיעוד מחירי הפתיחה נכשלה' });
  }
});

module.exports = router;

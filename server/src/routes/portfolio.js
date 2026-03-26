const express = require('express');
const {
  getPortfolio,
  addHolding,
  removeHolding,
  addWatchlistItem,
  removeWatchlistItem
} = require('../services/portfolioService');

const router = express.Router();

router.get('/', async (_request, response) => {
  try {
    const portfolio = await getPortfolio();
    response.json(portfolio);
  } catch (error) {
    console.error('Portfolio request failed', error);
    response.status(500).json({ message: 'טעינת האזור האישי נכשלה' });
  }
});

router.post('/holdings', async (request, response) => {
  try {
    const portfolio = await addHolding(request.body);
    response.status(201).json(portfolio);
  } catch (error) {
    response.status(400).json({ message: error.message || 'שמירת האחזקה נכשלה' });
  }
});

router.delete('/holdings/:id', async (request, response) => {
  try {
    const portfolio = await removeHolding(request.params.id);
    response.json(portfolio);
  } catch (error) {
    response.status(400).json({ message: error.message || 'מחיקת האחזקה נכשלה' });
  }
});

router.post('/watchlist', async (request, response) => {
  try {
    const portfolio = await addWatchlistItem(request.body);
    response.status(201).json(portfolio);
  } catch (error) {
    response.status(400).json({ message: error.message || 'שמירת רשימת המעקב נכשלה' });
  }
});

router.delete('/watchlist/:id', async (request, response) => {
  try {
    const portfolio = await removeWatchlistItem(request.params.id);
    response.json(portfolio);
  } catch (error) {
    response.status(400).json({ message: error.message || 'מחיקת פריט המעקב נכשלה' });
  }
});

module.exports = router;

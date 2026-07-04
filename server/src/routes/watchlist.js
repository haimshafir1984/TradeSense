const express = require('express');
const { buildTomorrowWatchlist } = require('../services/watchlistService');

const router = express.Router();

router.get('/tomorrow', async (request, response) => {
  try {
    const exchange = request.query.exchange || 'NASDAQ';
    const watchlist = await buildTomorrowWatchlist({ exchange });
    response.json({ exchange, watchlist });
  } catch (error) {
    console.error('Tomorrow watchlist request failed', error);
    response.status(500).json({
      message: 'בניית רשימת המעקב למחר נכשלה'
    });
  }
});

module.exports = router;

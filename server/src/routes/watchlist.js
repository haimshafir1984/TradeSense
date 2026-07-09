const express = require('express');
const { getTomorrowWatchlist } = require('../services/watchlistService');

const router = express.Router();

// Serves the cached watchlist (built automatically each evening by watchlistScheduler.js) so this
// is instant on the common path. Pass ?refresh=true to force a recompute on demand.
router.get('/tomorrow', async (request, response) => {
  try {
    const exchange = request.query.exchange || 'NASDAQ';
    const forceRefresh = request.query.refresh === 'true';
    const { generatedAt, watchlist } = await getTomorrowWatchlist({ exchange, forceRefresh });
    const dataSource = watchlist.length ? watchlist[0].dataSource : 'none';
    response.json({ exchange, generatedAt, watchlist, dataSource });
  } catch (error) {
    console.error('Tomorrow watchlist request failed', error);
    response.status(500).json({
      message: 'בניית רשימת המעקב למחר נכשלה'
    });
  }
});

module.exports = router;

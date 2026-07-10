const express = require('express');
const { getTomorrowWatchlist } = require('../services/watchlistService');
const { attachBreakoutLikelihood } = require('../services/watchlistLearningService');

const router = express.Router();

// Serves the cached watchlist (built automatically each evening by watchlistScheduler.js) so this
// is instant on the common path. Pass ?refresh=true to force a recompute on demand.
router.get('/tomorrow', async (request, response) => {
  try {
    const exchange = request.query.exchange || 'NASDAQ';
    const forceRefresh = request.query.refresh === 'true';
    const { generatedAt, watchlist, dataSource } = await getTomorrowWatchlist({ exchange, forceRefresh });
    // Enriched at read time (not cached alongside the watchlist itself) so the likelihood always
    // reflects the latest logged outcomes, even if the cached watchlist hasn't been recomputed.
    const watchlistWithLikelihood = await attachBreakoutLikelihood(watchlist);
    // dataSource is tracked at the entry level (see watchlistService.js) so a legitimate empty
    // result from the broad Alpaca funnel isn't mislabeled as the narrow FMP fallback. The
    // watchlist[0] fallback only matters for cache entries written before this field existed
    // (the persisted disk cache can outlive a deploy).
    const resolvedDataSource = dataSource || (watchlistWithLikelihood.length ? watchlistWithLikelihood[0].dataSource : 'none');
    response.json({ exchange, generatedAt, watchlist: watchlistWithLikelihood, dataSource: resolvedDataSource });
  } catch (error) {
    console.error('Tomorrow watchlist request failed', error);
    response.status(500).json({
      message: 'בניית רשימת המעקב למחר נכשלה'
    });
  }
});

module.exports = router;

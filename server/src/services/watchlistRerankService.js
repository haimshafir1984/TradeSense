// User-triggered pre-market re-rank for "tomorrow's watchlist" (docs/SPEC_SHORT_TERM_UPGRADE.md
// step 7): the watchlist itself is built the evening before from EOD data, predicting who *might*
// gap tomorrow. This takes one batched Alpaca snapshot request for the whole cached watchlist to
// see who actually gapped (and by how much) right now, and re-sorts by that - turning the EOD
// limitation into a 5-minute morning routine instead of a blind guess. Opt-in only (a button in
// the UI), never run automatically.
const alpacaService = require('./providers/alpacaService');
const watchlistService = require('./watchlistService');
const { round } = require('./mathUtils');

const UNAVAILABLE_MESSAGE = 'דירוג מחדש לפי פרה-מרקט אינו זמין כרגע (Alpaca לא מוגדר, או שלא התקבל נתון פרה-מרקט).';

async function rerankByPremarket({ exchange = 'NASDAQ' } = {}) {
  if (!alpacaService.isConfigured()) {
    return { available: false, message: UNAVAILABLE_MESSAGE };
  }

  const { watchlist } = await watchlistService.getTomorrowWatchlist({ exchange });

  if (!Array.isArray(watchlist) || !watchlist.length) {
    return { available: true, watchlist: [], snapshotAt: new Date().toISOString() };
  }

  const symbols = watchlist.map((item) => item.ticker);
  const snapshots = await alpacaService.getSnapshots({ symbols });

  if (!snapshots.size) {
    return { available: false, message: UNAVAILABLE_MESSAGE };
  }

  const withGapStatus = watchlist.map((item, index) => {
    const actualGapPct = computeActualGapPct(snapshots.get(item.ticker));

    if (!Number.isFinite(actualGapPct)) {
      return { ...item, actualGapPct: null, gapStatus: 'unknown', originalIndex: index };
    }

    const predictedGapPct = Number(item.daily_change) || 0;
    return {
      ...item,
      actualGapPct: round(actualGapPct, 2),
      gapStatus: classifyGapStatus(predictedGapPct, actualGapPct),
      originalIndex: index
    };
  });

  // Sorts by actual gap magnitude, strongest first; unknown-gap items (no snapshot data) keep
  // their original relative order at the back rather than being arbitrarily placed.
  withGapStatus.sort((left, right) => {
    const leftValue = Number.isFinite(left.actualGapPct) ? left.actualGapPct : -Infinity;
    const rightValue = Number.isFinite(right.actualGapPct) ? right.actualGapPct : -Infinity;
    return rightValue !== leftValue ? rightValue - leftValue : left.originalIndex - right.originalIndex;
  });

  return {
    available: true,
    watchlist: withGapStatus.map(({ originalIndex, ...rest }) => rest),
    snapshotAt: new Date().toISOString()
  };
}

// Prefers the latest trade price (works pre/post market on the IEX feed, within its coverage
// limits); falls back to today's daily bar close if no trade is available yet.
function computeActualGapPct(snapshot) {
  const currentPrice = Number(snapshot?.latestTrade?.p ?? snapshot?.dailyBar?.c);
  const previousClose = Number(snapshot?.prevDailyBar?.c);

  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return NaN;
  }

  return ((currentPrice - previousClose) / previousClose) * 100;
}

// "confirmed": the gap held the same direction and kept at least half its predicted magnitude.
// "faded": it reversed, or shrank to less than half of what the EOD prediction implied.
function classifyGapStatus(predictedGapPct, actualGapPct) {
  const sameSign = predictedGapPct === 0 || Math.sign(predictedGapPct) === Math.sign(actualGapPct);
  if (!sameSign) {
    return 'faded';
  }

  return Math.abs(actualGapPct) >= Math.abs(predictedGapPct) * 0.5 ? 'confirmed' : 'faded';
}

module.exports = {
  rerankByPremarket
};

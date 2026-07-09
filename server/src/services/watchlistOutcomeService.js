const { readWatchlistOutcomes, writeWatchlistOutcomes } = require('./watchlistOutcomeStore');
const { round } = require('./mathUtils');

// Lets the user log the real next-morning opening price for a tomorrow-watchlist candidate, so
// gapAccuracyPct shows how well the model's close price predicted the actual open - see
// docs/SPEC_MANUAL_TESTING_TOOLS.md section 3.
//
// modelClosePrice is passed in by the caller (the client already has it as `price` on the
// watchlist row being logged against) rather than re-derived here from the watchlist cache, to
// avoid a fragile cross-store date/ticker lookup for a value the caller already has in hand.
//
// The candidate's scoring fields (dailyChange, volumeRatio, adrPct, highProximity, rankScore) are
// captured the same way - snapshotted from the watchlist row at log time - so that once enough
// outcomes accumulate, watchlistLearningService.js can look up "what happened historically to
// candidates that looked like this one" without needing a fragile join back to a since-overwritten
// watchlist cache. All are optional: older records (or callers that don't pass them) simply don't
// participate in the learning lookup (see MIN_SAMPLE_SIZE handling there).
async function logActualOpen({
  date,
  ticker,
  actualOpenPrice,
  modelClosePrice,
  dailyChange,
  volumeRatio,
  adrPct,
  highProximity,
  rankScore
} = {}) {
  const normalizedDate = String(date || '').trim();
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const openPrice = toPositiveNumber(actualOpenPrice);
  const closePrice = toPositiveNumber(modelClosePrice);

  if (!normalizedDate) {
    throw new Error('יש לציין תאריך');
  }

  if (!normalizedTicker) {
    throw new Error('יש לציין סימול מניה');
  }

  if (!openPrice) {
    throw new Error('יש להזין מחיר פתיחה בפועל חיובי');
  }

  if (!closePrice) {
    throw new Error('חסר מחיר סגירה של המודל לצורך חישוב הדיוק');
  }

  const gapAccuracyPct = round(((openPrice - closePrice) / closePrice) * 100, 2);

  const outcomes = await readWatchlistOutcomes();
  const existingIndex = outcomes.findIndex(
    (entry) => entry.date === normalizedDate && entry.ticker === normalizedTicker
  );

  const record = {
    id: existingIndex >= 0 ? outcomes[existingIndex].id : createId(),
    date: normalizedDate,
    ticker: normalizedTicker,
    modelClosePrice: closePrice,
    actualOpenPrice: openPrice,
    gapAccuracyPct,
    dailyChangeAtLog: toFiniteOrNull(dailyChange),
    volumeRatioAtLog: toFiniteOrNull(volumeRatio),
    adrPctAtLog: toFiniteOrNull(adrPct),
    highProximityAtLog: toFiniteOrNull(highProximity),
    rankScoreAtLog: toFiniteOrNull(rankScore),
    loggedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    outcomes[existingIndex] = record; // upsert: update in place, never duplicate
  } else {
    outcomes.push(record);
  }

  await writeWatchlistOutcomes(outcomes);
  return record;
}

async function getOutcomesForDate(date) {
  const normalizedDate = String(date || '').trim();
  const outcomes = await readWatchlistOutcomes();
  const forDate = outcomes.filter((entry) => entry.date === normalizedDate);

  return new Map(forDate.map((entry) => [entry.ticker, entry]));
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toFiniteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createId() {
  return `outcome_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  logActualOpen,
  getOutcomesForDate
};

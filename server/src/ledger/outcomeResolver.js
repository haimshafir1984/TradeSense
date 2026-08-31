// Fills in what actually happened to a logged candidate, from real price data only
// (docs/SPEC_V2_ARCHITECTURE.md §5.7) - no manual entry, ever. Runs once a day
// (npm run ledger:resolve, or POST /api/ledger/resolve per §6) against every unresolved entry.
const alpacaService = require('../providers/alpacaService');
const { round } = require('../services/mathUtils');
const ledgerStore = require('./ledgerStore');

// Fixed horizons the report tracks return at, regardless of when/whether the trade actually exited
// - lets playbookStats compare "what would a fixed hold have done" against the plan's own exit.
const RETURN_HORIZONS_DAYS = [1, 3, 5, 10, 20];

// Pure core: given a trade plan and the bars strictly AFTER the entry day (anti-lookahead - never
// pass a bar dated on or before entry), determines what happened. Direction is inferred from
// whether the stop sits below or above entry (every playbook so far is long-only, but this stays
// generic rather than assuming).
//
// Tie-break rule when a single bar's range touches both stop and target: the stop is assumed hit
// first. This is the standard conservative backtesting convention - it never credits a trade with
// a better outcome than a worst-case reading of the same bar would support.
function resolveOutcomeFromBars(plan, barsAfterEntry) {
  if (!plan || !plan.valid || !Array.isArray(barsAfterEntry)) {
    return null;
  }

  const entryPrice = plan.entry.price;
  const stopPrice = plan.stop.price;
  const targetPrice = plan.target.price;
  const timeStopDays = plan.timeStopDays;
  const isLong = stopPrice < entryPrice;

  const returnPct = {};
  for (const horizon of RETURN_HORIZONS_DAYS) {
    const bar = barsAfterEntry[horizon - 1];
    returnPct[`d${horizon}`] = bar && Number.isFinite(Number(bar.c)) ? round(((Number(bar.c) - entryPrice) / entryPrice) * 100, 2) : null;
  }

  let exitReason = 'open';
  let exitIndex = null;
  let exitPrice = null;

  const decisionWindow = Number.isFinite(timeStopDays) ? Math.min(barsAfterEntry.length, timeStopDays) : barsAfterEntry.length;

  for (let index = 0; index < decisionWindow; index += 1) {
    const bar = barsAfterEntry[index];
    const high = Number(bar?.h);
    const low = Number(bar?.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      continue;
    }

    const stopHit = isLong ? low <= stopPrice : high >= stopPrice;
    const targetHit = isLong ? high >= targetPrice : low <= targetPrice;

    if (stopHit) {
      exitReason = 'stop';
      exitIndex = index;
      exitPrice = stopPrice;
      break;
    }
    if (targetHit) {
      exitReason = 'target';
      exitIndex = index;
      exitPrice = targetPrice;
      break;
    }
  }

  if (exitReason === 'open' && Number.isFinite(timeStopDays) && barsAfterEntry.length >= timeStopDays) {
    const timeStopBar = barsAfterEntry[timeStopDays - 1];
    exitReason = 'time_stop';
    exitIndex = timeStopDays - 1;
    exitPrice = Number(timeStopBar?.c);
  }

  const excursionWindow = barsAfterEntry.slice(0, exitIndex !== null ? exitIndex + 1 : decisionWindow);
  const highs = excursionWindow.map((bar) => Number(bar?.h)).filter(Number.isFinite);
  const lows = excursionWindow.map((bar) => Number(bar?.l)).filter(Number.isFinite);

  const bestPrice = isLong ? (highs.length ? Math.max(...highs) : null) : (lows.length ? Math.min(...lows) : null);
  const worstPrice = isLong ? (lows.length ? Math.min(...lows) : null) : (highs.length ? Math.max(...highs) : null);

  const mfePct = bestPrice !== null ? round(((bestPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1), 2) : null;
  const maePct = worstPrice !== null ? round(((worstPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1), 2) : null;

  const stopDistance = Math.abs(entryPrice - stopPrice);
  let rMultiple = null;
  if (exitReason === 'target') {
    rMultiple = plan.target.rMultiple;
  } else if (exitReason === 'stop') {
    rMultiple = -1;
  } else if (exitReason === 'time_stop' && Number.isFinite(exitPrice) && stopDistance > 0) {
    const priceMove = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    rMultiple = round(priceMove / stopDistance, 2);
  }

  return {
    resolvedAt: exitReason === 'open' ? null : new Date().toISOString(),
    exitReason,
    returnPct,
    mfePct,
    maePct,
    rMultiple
  };
}

// Fetches bars for one ticker starting the day after entry.createdAt through today, resolves the
// outcome, and persists it. Skips entries whose plan was never valid (nothing to resolve) or whose
// createdAt is unparseable.
async function resolveEntry(entry) {
  if (!entry?.plan?.valid) {
    return null;
  }

  const entryDate = new Date(entry.createdAt);
  if (Number.isNaN(entryDate.getTime())) {
    return null;
  }

  // getDailyBars takes a "days back from today" window - request enough to comfortably cover the
  // longest fixed horizon (20 trading days) plus the entry's own time-stop, from the entry date to
  // now.
  const daysSinceEntry = Math.ceil((Date.now() - entryDate.getTime()) / (24 * 60 * 60 * 1000));
  const barsMap = await alpacaService.getDailyBars({ symbols: [entry.ticker], days: daysSinceEntry + 5 });
  const allBars = barsMap.get(entry.ticker) || [];

  // Anti-lookahead: only bars strictly AFTER the entry day feed the outcome.
  const barsAfterEntry = allBars.filter((bar) => new Date(bar.t).getTime() > entryDate.getTime());

  const outcome = resolveOutcomeFromBars(entry.plan, barsAfterEntry);
  if (!outcome) {
    return null;
  }

  return ledgerStore.updateOutcome(entry.id, outcome);
}

// Processes every unresolved entry. Fail-soft per entry (§1 rule 5) - one ticker's bars failing to
// fetch doesn't stop the rest of the run.
async function resolveAll() {
  const unresolved = await ledgerStore.readUnresolvedEntries();
  const results = [];

  for (const entry of unresolved) {
    try {
      const updated = await resolveEntry(entry);
      if (updated) {
        results.push(updated);
      }
    } catch (error) {
      console.warn(`[outcomeResolver] Failed to resolve ${entry.ticker} (${entry.id}): ${error.message}`);
    }
  }

  return results;
}

module.exports = {
  resolveOutcomeFromBars,
  resolveEntry,
  resolveAll
};

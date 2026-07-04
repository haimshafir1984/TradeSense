const watchlistService = require('./watchlistService');

// Runs the (evening) tomorrow-watchlist scan automatically once a day, so the cache is already
// warm by the time someone opens the app - no manual "load" step. This only fires while the
// server process is actually running at/after the scheduled hour; it does not wake up a stopped
// server. If the server was offline through the scheduled hour, getTomorrowWatchlist's own
// freshness check (CACHE_FRESHNESS_MS) still recomputes on the next request, so the feature
// degrades gracefully rather than silently serving a days-old list.
const DEFAULT_SCHEDULE_HOUR = 22; // 22:00 server-local time, after the US market close
const DEFAULT_EXCHANGES = ['NASDAQ', 'NYSE'];
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

let lastRunDateKey = null;
let intervalHandle = null;

function getScheduleHour() {
  const parsed = Number(process.env.WATCHLIST_SCHEDULE_HOUR);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_SCHEDULE_HOUR;
}

function getScheduledExchanges() {
  const raw = process.env.WATCHLIST_SCHEDULE_EXCHANGES;
  if (!raw) {
    return DEFAULT_EXCHANGES;
  }

  const parsed = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_EXCHANGES;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function refreshAllExchanges() {
  for (const exchange of getScheduledExchanges()) {
    try {
      await watchlistService.getTomorrowWatchlist({ exchange, forceRefresh: true });
      console.log(`[watchlistScheduler] Refreshed tomorrow watchlist for ${exchange}`);
    } catch (error) {
      console.warn(`[watchlistScheduler] Failed to refresh tomorrow watchlist for ${exchange}: ${error.message}`);
    }
  }
}

async function checkAndRun(now = new Date()) {
  const today = dateKey(now);

  if (lastRunDateKey === today || now.getHours() < getScheduleHour()) {
    return;
  }

  lastRunDateKey = today;
  await refreshAllExchanges();
}

// Starts the recurring check. Safe to call once at server boot; checkAndRun itself is
// idempotent per calendar day.
function startWatchlistScheduler() {
  if (intervalHandle) {
    return;
  }

  checkAndRun();
  intervalHandle = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stopWatchlistScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  lastRunDateKey = null;
}

module.exports = {
  startWatchlistScheduler,
  stopWatchlistScheduler,
  checkAndRun
};

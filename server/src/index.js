const path = require('path');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: rootEnvPath });

const app = require('./app');

const port = Number(process.env.PORT || 4000);

console.log(`[startup] Loaded env from ${rootEnvPath}`);
console.log(`[startup] DATA_MODE=${process.env.DATA_MODE || 'undefined'} FINNHUB_API_KEY=${process.env.FINNHUB_API_KEY ? 'present' : 'missing'} CLIENT_ORIGIN=${process.env.CLIENT_ORIGIN || 'undefined'}`);

// v2 rebuild (docs/SPEC_V2_ARCHITECTURE.md §2): watchlistScheduler.js (which used to trigger both
// the nightly watchlist refresh and the nightly universe refresh) is deleted along with the rest
// of the watchlist family. universeBuilderService's lazy-refresh path (getUniverseWithLazyRefresh,
// §3.4) still keeps the universe usable without a scheduler - a stale (24-72h) universe is served
// immediately with a background refresh kicked off, and a missing/very-stale one is refreshed
// synchronously on that request. What's lost without a scheduler is *pre-warming*: the very first
// request after a long-stale period pays the refresh cost synchronously instead of it having
// already happened overnight. A dedicated nightly trigger (cron/setInterval, calling
// universeBuilderService.refreshUniverse directly - no watchlist involved) should be added back in
// a later phase; tracked here rather than silently dropped.
app.listen(port, () => {
  console.log(`TradeSense API listening on port ${port}`);
});
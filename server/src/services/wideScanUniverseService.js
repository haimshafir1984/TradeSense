// Opt-in wide-universe scan for the main scanner (docs/SPEC_SHORT_TERM_UPGRADE.md step 4): reuses
// the same Alpaca-backed "wide and cheap, then full history" pipeline as the tomorrow-watchlist
// funnel (funnelScanService.js) to discover candidates outside the pre-filtered, nightly-refreshed
// universe (universeStore.js - typically a few hundred to ~1000 symbols). Unlike the funnel, this
// returns full stock objects (via barsStockBuilder, no market cap - see below) ready for
// scoreStockByStrategy - no gap-and-go-specific eligibility filter is applied here; each strategy's
// own eligibility gate in strategies.js decides who actually scores.
//
// Deliberately NOT offered for small_cap_breakout (see docs/SPEC_SHORT_TERM_UPGRADE.md "סטיות
// מהתכנון"): that strategy's eligibility gate hard-requires a real market_cap, which this stage-1
// scan doesn't fetch (fetching it for thousands of candidates would defeat the point of keeping
// this cheap) - small_cap_breakout already has its own dedicated, real-market-cap wide-ish universe
// (smallCapUniverseService.js) that runs unconditionally, wideScan or not.
//
// Costs dozens of sequential Alpaca requests (~40-70s, same as funnelScanService's stage 1) - opt-in
// only, never triggered by a default scan.
const alpacaService = require('./providers/alpacaService');
const { buildStockFromBars } = require('./barsStockBuilder');

const WIDE_SCAN_MIN_PRICE = Number(process.env.FUNNEL_MIN_PRICE) || 1;
const WIDE_SCAN_MAX_PRICE = Number(process.env.FUNNEL_MAX_PRICE) || 500;
const WIDE_SCAN_MIN_DOLLAR_VOLUME = Number(process.env.FUNNEL_MIN_DOLLAR_VOLUME) || 5000000;
const WIDE_SCAN_STAGE2_SIZE = Number(process.env.WIDE_SCAN_STAGE2_SIZE) || 300;
// Minimum bars needed for the ADR/MA50/high-52w math in buildStockFromBars to mean anything - same
// floor smallCapUniverseService.js uses.
const MIN_BARS_FOR_WIDE_SCAN = 60;
const HISTORY_DAYS = 420; // ~290 trading days - enough for a (possibly partial) MA200.

async function scanWideUniverse({ exchange = 'NASDAQ' } = {}) {
  if (!alpacaService.isConfigured()) {
    return null;
  }

  const stage1Survivors = await runStage1(exchange);
  if (stage1Survivors === null) {
    return null;
  }

  if (!stage1Survivors.length) {
    return [];
  }

  return buildStocksFromSurvivors(exchange, stage1Survivors);
}

// Wide and cheap: every active asset on the exchange, filtered locally on the single latest daily
// bar (price band, dollar volume). Sorted by liquidity (not "moved up today", unlike the
// gap-and-go funnel) since this feeds general strategy scoring, not a momentum-only watchlist.
async function runStage1(exchange) {
  const assets = await alpacaService.getActiveAssets({ exchange });
  if (!assets.length) {
    return null;
  }

  const nameBySymbol = new Map(assets.map((asset) => [asset.symbol, asset.name]));
  const symbols = assets.map((asset) => asset.symbol);
  const latestBars = await alpacaService.getLatestDailyBars({ symbols });

  if (!latestBars.size) {
    return null;
  }

  const survivors = [];

  for (const [symbol, bar] of latestBars) {
    const close = Number(bar?.c);
    const volume = Number(bar?.v);

    if (!Number.isFinite(close) || !Number.isFinite(volume)) {
      continue;
    }

    if (close < WIDE_SCAN_MIN_PRICE || close > WIDE_SCAN_MAX_PRICE) {
      continue;
    }

    const dollarVolume = close * volume;
    if (dollarVolume < WIDE_SCAN_MIN_DOLLAR_VOLUME) {
      continue;
    }

    survivors.push({ symbol, companyName: nameBySymbol.get(symbol) || symbol, dollarVolume });
  }

  return survivors
    .sort((left, right) => right.dollarVolume - left.dollarVolume)
    .slice(0, WIDE_SCAN_STAGE2_SIZE);
}

// Full 90+ day history for the stage-1 survivors, built into the same stock-object shape every
// other provider produces (barsStockBuilder.js), so scoreStockByStrategy can't tell the difference.
// market_cap is deliberately null (see file header) - only small_cap_breakout's eligibility gate
// requires it, and that strategy doesn't use this path.
async function buildStocksFromSurvivors(exchange, survivors) {
  const candidateBySymbol = new Map(survivors.map((entry) => [entry.symbol, entry]));
  const symbols = survivors.map((entry) => entry.symbol);
  const barsBySymbol = await alpacaService.getDailyBars({ symbols, days: HISTORY_DAYS });

  const stocks = [];

  for (const [symbol, bars] of barsBySymbol) {
    if (!Array.isArray(bars) || bars.length < MIN_BARS_FOR_WIDE_SCAN) {
      continue;
    }

    const candidate = candidateBySymbol.get(symbol);
    if (!candidate) {
      continue;
    }

    const stock = buildStockFromBars({
      exchange,
      candidate: { symbol, companyName: candidate.companyName, sector: 'Unknown', marketCap: null },
      bars,
      dataSource: 'alpaca+wide-scan'
    });

    if (stock) {
      stocks.push(stock);
    }
  }

  return stocks;
}

module.exports = {
  scanWideUniverse
};

// Orchestrates stages 0-2 and 6 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.0-§5.2/§5.6) into
// one shortlist. Playbook evaluation (stage 3) is added on top of this shortlist in a later phase
// (§10 phases 4/5/9) - this file's job ends at "here are the liquid, catalyst-tagged, high-rvol
// candidates, and here's whether the regime blocks any risk tier."
//
// `diagnostics` explains every symbol dropped at every stage (§6) - the point is that "0
// candidates" reads as information (every reason it happened), never as an unexplained empty list.
const universeBuilderService = require('../services/universeBuilderService');
const alpacaService = require('../providers/alpacaService');
const { computeFeaturesFromBars } = require('../playbooks/features.js');
const { applyLiquidityGate } = require('./liquidityGate');
const catalystService = require('./catalystService');
const selectionService = require('./selectionService');
const regimeGate = require('./regimeGate');

// Needs to comfortably clear liquidityGate's 200-daily-bar floor (§5.0) after weekends/holidays -
// 320 calendar days is ~220 trading days.
const FEATURE_HISTORY_DAYS = 320;
// Caps how many rejected-liquidity entries diagnostics carries, so a 1000-symbol universe doesn't
// balloon the response - the counts are what matters, the sample is just illustrative.
const REJECTED_SAMPLE_LIMIT = 25;

async function runScan({ exchange = 'NASDAQ', topN = 20 } = {}) {
  const generatedAt = new Date().toISOString();
  const universe = await universeBuilderService.getUniverseWithLazyRefresh(exchange);

  if (!universe || !Array.isArray(universe.rows) || !universe.rows.length) {
    return emptyResult(generatedAt, exchange, 'universe', 'לא נמצא universe שמור לבורסה זו - נסה שוב בעוד רגע (הרענון קורה ברקע).');
  }

  const symbols = universe.rows.map((row) => row.symbol);
  const barsBySymbol = await alpacaService.getDailyBars({ symbols, days: FEATURE_HISTORY_DAYS });

  const enriched = universe.rows.map((row) => ({
    symbol: row.symbol,
    companyName: row.companyName,
    sector: row.sector || 'Unknown',
    marketCap: Number.isFinite(row.marketCap) ? row.marketCap : null,
    ...computeFeaturesFromBars(barsBySymbol.get(row.symbol) || [])
  }));

  const { passed: liquidityPassed, rejected: liquidityRejected } = applyLiquidityGate(enriched);

  if (!liquidityPassed.length) {
    return emptyResult(generatedAt, exchange, 'liquidity', 'אף מניה לא עברה את שער הנזילות.', {
      universeCount: universe.rows.length,
      afterLiquidityGate: 0,
      liquidityRejectedSample: liquidityRejected.slice(0, REJECTED_SAMPLE_LIMIT)
    });
  }

  const catalystBySymbol = await catalystService.detectCatalysts(liquidityPassed.map((stock) => stock.symbol));
  const withCatalyst = liquidityPassed.map((stock) => ({
    ...stock,
    catalyst: catalystBySymbol.get(stock.symbol) || null
  }));

  const shortlist = selectionService.rankByRelativeVolume(withCatalyst, { topN });
  const regime = await regimeGate.assessRegime();

  return {
    generatedAt,
    exchange,
    shortlist,
    regime,
    diagnostics: {
      universeCount: universe.rows.length,
      afterLiquidityGate: liquidityPassed.length,
      liquidityRejectedSample: liquidityRejected.slice(0, REJECTED_SAMPLE_LIMIT),
      afterSelection: shortlist.length
    },
    warnings: []
  };
}

function emptyResult(generatedAt, exchange, stage, message, diagnostics = {}) {
  return {
    generatedAt,
    exchange,
    shortlist: [],
    regime: null,
    diagnostics: { stage, ...diagnostics },
    warnings: [message]
  };
}

module.exports = {
  runScan
};

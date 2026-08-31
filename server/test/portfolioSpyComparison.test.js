const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Rewritten for docs/SPEC_V2_ARCHITECTURE.md §2: portfolioService now sources prices from
// alpacaService.getSnapshots (the one provider the new architecture keeps for this), not the
// deleted marketDataService. Tests patch that real boundary directly instead of an internal shim.
function freshPortfolioService(scratchPath) {
  process.env.PORTFOLIO_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/portfolioStore')];
  delete require.cache[require.resolve('../src/services/portfolioService')];
  delete require.cache[require.resolve('../src/providers/alpacaService')];
  return {
    portfolioService: require('../src/services/portfolioService'),
    alpacaService: require('../src/providers/alpacaService')
  };
}

// Builds the Map<symbol, snapshot> shape alpacaService.getSnapshots resolves to, from a plain
// {SYMBOL: price} map - keeps the test bodies focused on the numbers, not Alpaca's wire shape.
function snapshotMapFromPrices(prices, previousCloses = {}) {
  const map = new Map();
  for (const [ticker, price] of Object.entries(prices)) {
    const prevClose = previousCloses[ticker];
    map.set(ticker, {
      latestTrade: { p: price },
      dailyBar: { c: price },
      prevDailyBar: prevClose != null ? { c: prevClose } : undefined
    });
  }
  return map;
}

test('addHolding stores spyPriceAtPurchase and getPortfolio computes excessReturnPct (positive case)', async () => {
  const scratchPath = path.join(os.tmpdir(), `portfolio-spy-positive-${Date.now()}.json`);
  const { portfolioService, alpacaService } = freshPortfolioService(scratchPath);
  const originalGetSnapshots = alpacaService.getSnapshots;

  // At purchase time: SPY is 500.
  alpacaService.getSnapshots = async () => snapshotMapFromPrices({ SPY: 500 });

  await portfolioService.addHolding({
    ticker: 'AMZN',
    quantity: 10,
    averageBuyPrice: 100,
    purchaseDate: '2026-01-01'
  });

  // Now, at getPortfolio time: SPY rose to 550 (+10%), stock rose to 130 (+30%) -> excess = +20%.
  alpacaService.getSnapshots = async () => snapshotMapFromPrices({ SPY: 550, AMZN: 130 });

  const portfolio = await portfolioService.getPortfolio();

  alpacaService.getSnapshots = originalGetSnapshots;
  fs.unlinkSync(scratchPath);
  delete process.env.PORTFOLIO_STORE_FILE_PATH;

  const holding = portfolio.holdings.find((item) => item.ticker === 'AMZN');
  assert.ok(holding);
  assert.equal(holding.spyPriceAtPurchase, 500);
  assert.equal(holding.spyReturnPct, 10);
  assert.equal(holding.changeFromBuyPricePct, 30);
  assert.equal(holding.excessReturnPct, 20);
});

test('getPortfolio computes a negative excessReturnPct when the stock lags SPY', async () => {
  const scratchPath = path.join(os.tmpdir(), `portfolio-spy-negative-${Date.now()}.json`);
  const { portfolioService, alpacaService } = freshPortfolioService(scratchPath);
  const originalGetSnapshots = alpacaService.getSnapshots;

  alpacaService.getSnapshots = async () => snapshotMapFromPrices({ SPY: 400 });

  await portfolioService.addHolding({
    ticker: 'LAGGARD',
    quantity: 5,
    averageBuyPrice: 50,
    purchaseDate: '2026-01-01'
  });

  // SPY rises +10%, stock only rises +2% -> excess = -8%.
  alpacaService.getSnapshots = async () => snapshotMapFromPrices({ SPY: 440, LAGGARD: 51 });

  const portfolio = await portfolioService.getPortfolio();

  alpacaService.getSnapshots = originalGetSnapshots;
  fs.unlinkSync(scratchPath);
  delete process.env.PORTFOLIO_STORE_FILE_PATH;

  const holding = portfolio.holdings.find((item) => item.ticker === 'LAGGARD');
  assert.ok(holding);
  assert.equal(holding.spyReturnPct, 10);
  assert.equal(holding.changeFromBuyPricePct, 2);
  assert.equal(holding.excessReturnPct, -8);
});

test('a holding without spyPriceAtPurchase gets null spyReturnPct/excessReturnPct instead of crashing', async () => {
  const scratchPath = path.join(os.tmpdir(), `portfolio-spy-legacy-${Date.now()}.json`);
  const { portfolioService, alpacaService } = freshPortfolioService(scratchPath);
  const originalGetSnapshots = alpacaService.getSnapshots;

  // Simulate a pre-existing holding (added before this feature shipped) by writing the scratch
  // file directly, without going through addHolding.
  fs.writeFileSync(
    scratchPath,
    JSON.stringify(
      {
        holdings: [
          {
            id: 'holding_legacy',
            ticker: 'OLD',
            quantity: 1,
            averageBuyPrice: 10,
            investedAmount: 10,
            purchaseDate: '2025-01-01',
            note: '',
            createdAt: new Date().toISOString()
            // no spyPriceAtPurchase field at all
          }
        ],
        watchlist: []
      },
      null,
      2
    )
  );

  alpacaService.getSnapshots = async () => snapshotMapFromPrices({ SPY: 500, OLD: 12 });

  const portfolio = await portfolioService.getPortfolio();

  alpacaService.getSnapshots = originalGetSnapshots;
  fs.unlinkSync(scratchPath);
  delete process.env.PORTFOLIO_STORE_FILE_PATH;

  const holding = portfolio.holdings.find((item) => item.ticker === 'OLD');
  assert.ok(holding);
  assert.equal(holding.spyReturnPct, null);
  assert.equal(holding.excessReturnPct, null);
  assert.equal(holding.changeFromBuyPricePct, 20); // still computed fine, unrelated to SPY
});

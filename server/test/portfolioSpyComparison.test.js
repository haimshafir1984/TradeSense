const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshPortfolioService(scratchPath) {
  process.env.PORTFOLIO_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/portfolioStore')];
  delete require.cache[require.resolve('../src/services/portfolioService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  return {
    portfolioService: require('../src/services/portfolioService'),
    marketDataService: require('../src/services/marketDataService')
  };
}

test('addHolding stores spyPriceAtPurchase and getPortfolio computes excessReturnPct (positive case)', async () => {
  const scratchPath = path.join(os.tmpdir(), `portfolio-spy-positive-${Date.now()}.json`);
  const { portfolioService, marketDataService } = freshPortfolioService(scratchPath);
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  const originalGetStockSnapshots = marketDataService.getStockSnapshots;

  // At purchase time: SPY is 500.
  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { ticker: 'SPY', price: 500 };
    return { ticker, price: 100 };
  };

  await portfolioService.addHolding({
    ticker: 'AMZN',
    quantity: 10,
    averageBuyPrice: 100,
    purchaseDate: '2026-01-01'
  });

  // Now, at getPortfolio time: SPY rose to 550 (+10%), stock rose to 130 (+30%) -> excess = +20%.
  marketDataService.getStockSnapshots = async (tickers) =>
    tickers.map((ticker) => {
      if (ticker === 'SPY') return { ticker: 'SPY', price: 550 };
      if (ticker === 'AMZN') return { ticker: 'AMZN', price: 130 };
      return { ticker, price: 100 };
    });

  const portfolio = await portfolioService.getPortfolio();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  marketDataService.getStockSnapshots = originalGetStockSnapshots;
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
  const { portfolioService, marketDataService } = freshPortfolioService(scratchPath);
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  const originalGetStockSnapshots = marketDataService.getStockSnapshots;

  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { ticker: 'SPY', price: 400 };
    return { ticker, price: 50 };
  };

  await portfolioService.addHolding({
    ticker: 'LAGGARD',
    quantity: 5,
    averageBuyPrice: 50,
    purchaseDate: '2026-01-01'
  });

  // SPY rises +10%, stock only rises +2% -> excess = -8%.
  marketDataService.getStockSnapshots = async (tickers) =>
    tickers.map((ticker) => {
      if (ticker === 'SPY') return { ticker: 'SPY', price: 440 };
      if (ticker === 'LAGGARD') return { ticker: 'LAGGARD', price: 51 };
      return { ticker, price: 100 };
    });

  const portfolio = await portfolioService.getPortfolio();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  marketDataService.getStockSnapshots = originalGetStockSnapshots;
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
  const { portfolioService, marketDataService } = freshPortfolioService(scratchPath);
  const originalGetStockSnapshots = marketDataService.getStockSnapshots;

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

  marketDataService.getStockSnapshots = async (tickers) =>
    tickers.map((ticker) => {
      if (ticker === 'SPY') return { ticker: 'SPY', price: 500 };
      if (ticker === 'OLD') return { ticker: 'OLD', price: 12 };
      return { ticker, price: 100 };
    });

  const portfolio = await portfolioService.getPortfolio();

  marketDataService.getStockSnapshots = originalGetStockSnapshots;
  fs.unlinkSync(scratchPath);
  delete process.env.PORTFOLIO_STORE_FILE_PATH;

  const holding = portfolio.holdings.find((item) => item.ticker === 'OLD');
  assert.ok(holding);
  assert.equal(holding.spyReturnPct, null);
  assert.equal(holding.excessReturnPct, null);
  assert.equal(holding.changeFromBuyPricePct, 20); // still computed fine, unrelated to SPY
});

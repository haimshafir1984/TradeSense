const fs = require('fs/promises');
const path = require('path');

const portfolioPath = path.resolve(__dirname, '../data/portfolio.json');

async function readPortfolio() {
  try {
    const raw = await fs.readFile(portfolioPath, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { holdings: [], watchlist: [] };
    }

    throw error;
  }
}

async function writePortfolio(portfolio) {
  const normalized = {
    holdings: Array.isArray(portfolio.holdings) ? portfolio.holdings : [],
    watchlist: Array.isArray(portfolio.watchlist) ? portfolio.watchlist : []
  };

  await fs.writeFile(portfolioPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

module.exports = {
  readPortfolio,
  writePortfolio
};

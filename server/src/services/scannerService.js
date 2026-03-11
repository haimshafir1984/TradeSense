const { getMarketData } = require('./marketDataService');
const { STRATEGY_LABELS, scoreStockByStrategy } = require('./strategies');

async function analyzeMarket(request = {}) {
  const exchange = request.exchange || 'NASDAQ';
  const strategy = request.strategy || 'micha_stocks';
  const risk = request.risk || 'medium';
  const filters = request.filters || {};

  console.log('[analyze] Incoming request', {
    exchange,
    strategy,
    risk,
    filters
  });

  const { stocks, source } = await getMarketData(exchange);
  const filteredStocks = stocks.filter((stock) => applyFilters(stock, filters, risk));
  const scoredStocks = filteredStocks
    .map((stock) => scoreStockByStrategy(strategy, stock))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);

  console.log('[analyze] Completed scan', {
    exchange,
    strategy,
    source,
    totalStocks: stocks.length,
    filteredStocks: filteredStocks.length,
    returnedStocks: scoredStocks.length
  });

  return {
    results: scoredStocks.map((stock) => ({
      ticker: stock.ticker,
      companyName: stock.companyName,
      matchScore: Math.round(stock.score * 100),
      strategyName: STRATEGY_LABELS[strategy] || STRATEGY_LABELS.micha_stocks,
      explanation: stock.explanation
    })),
    meta: {
      exchange,
      strategy,
      risk,
      source,
      analyzedCount: filteredStocks.length,
      returnedCount: Math.min(scoredStocks.length, 10)
    }
  };
}

function applyFilters(stock, filters, risk) {
  const minDividendYield = toNumber(filters.minDividendYield);
  const minVolume = toNumber(filters.minVolume);
  const minPrice = toNumber(filters.minPrice);
  const maxPrice = toNumber(filters.maxPrice);
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;

  if (filters.dividendOnly && stock.dividend_yield <= 0) {
    return false;
  }

  if (minDividendYield && stock.dividend_yield < minDividendYield) {
    return false;
  }

  if (filters.sector && filters.sector !== 'Any' && stock.sector !== filters.sector) {
    return false;
  }

  if (!matchesMarketCap(stock.market_cap, filters.marketCap)) {
    return false;
  }

  if (minVolume && stock.volume < minVolume) {
    return false;
  }

  if (minPrice && stock.price < minPrice) {
    return false;
  }

  if (maxPrice && stock.price > maxPrice) {
    return false;
  }

  if (!matchesVolatility(stock.volatility, filters.volatility)) {
    return false;
  }

  if (filters.unusualVolume && volumeRatio <= 2) {
    return false;
  }

  if (filters.institutionalBuying && stock.institutional_inflow <= 0) {
    return false;
  }

  if (filters.insiderBuying && stock.insider_transactions <= 0) {
    return false;
  }

  if (!matchesRisk(stock, risk)) {
    return false;
  }

  return true;
}

function matchesMarketCap(marketCap, selected) {
  if (!selected || selected === 'any') {
    return true;
  }

  if (selected === 'large') {
    return marketCap > 10000000000;
  }

  if (selected === 'mid') {
    return marketCap >= 2000000000 && marketCap <= 10000000000;
  }

  if (selected === 'small') {
    return marketCap < 2000000000;
  }

  return true;
}

function matchesVolatility(volatility, selected) {
  if (!selected || selected === 'any') {
    return true;
  }

  if (selected === 'low') {
    return volatility < 0.025;
  }

  if (selected === 'medium') {
    return volatility >= 0.025 && volatility < 0.05;
  }

  if (selected === 'high') {
    return volatility >= 0.05;
  }

  return true;
}

function matchesRisk(stock, risk) {
  if (risk === 'low') {
    return stock.volatility < 0.03 && stock.market_cap >= 5000000000;
  }

  if (risk === 'medium') {
    return stock.volatility < 0.055;
  }

  return true;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  analyzeMarket
};
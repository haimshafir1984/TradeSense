// v2 rebuild (docs/SPEC_V2_ARCHITECTURE.md §2): the old marketDataService (FMP-based) is deleted.
// Portfolio is an unchanged feature per §2, so its price lookups are rebuilt directly on the one
// provider the new architecture keeps for this purpose - alpacaService.getSnapshots (§3.1).
// Company name/sector aren't available from that endpoint, so they fall back to the ticker /
// 'Unknown' exactly as they already did for any symbol marketDataService couldn't resolve either -
// this is not a behavior regression, just a narrower data source.
const alpacaService = require('../providers/alpacaService');
const { readPortfolio, writePortfolio } = require('./portfolioStore');
const { round } = require('./mathUtils');

// Exported as an object (not destructured functions) so tests can monkey-patch
// marketDataService.getStockSnapshots(...) the same way they patched the old module.
const marketDataService = {
  async getStockSnapshots(symbols) {
    const snapshotMap = await alpacaService.getSnapshots({ symbols });
    return symbols.map((ticker) => toPortfolioSnapshot(ticker, snapshotMap.get(ticker)));
  },
  async getStockSnapshot(ticker) {
    const snapshotMap = await alpacaService.getSnapshots({ symbols: [ticker] });
    return toPortfolioSnapshot(ticker, snapshotMap.get(ticker));
  }
};

// Alpaca's raw snapshot shape (dailyBar/prevDailyBar/latestTrade) -> the flat fields this file's
// enrichHolding/enrichWatchlistItem already expect. Missing pieces stay null/undefined rather than
// fabricated, consistent with §1 rule 1.
function toPortfolioSnapshot(ticker, snapshot) {
  if (!snapshot) {
    return { ticker, price: null, daily_change: null, companyName: null, sector: null, data_source: 'alpaca' };
  }

  const price = Number(snapshot.latestTrade?.p ?? snapshot.dailyBar?.c);
  const previousClose = Number(snapshot.prevDailyBar?.c);
  const dailyChange =
    Number.isFinite(price) && Number.isFinite(previousClose) && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null;

  return {
    ticker,
    price: Number.isFinite(price) ? price : null,
    daily_change: dailyChange,
    companyName: null,
    sector: null,
    data_source: 'alpaca'
  };
}

async function getPortfolio() {
  const portfolio = await readPortfolio();
  const symbols = uniqueTickers([
    'SPY',
    ...portfolio.holdings.map((holding) => holding.ticker),
    ...portfolio.watchlist.map((item) => item.ticker)
  ]);
  const snapshots = symbols.length ? await marketDataService.getStockSnapshots(symbols) : [];
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.ticker, snapshot]));
  const spySnapshot = snapshotMap.get('SPY');

  const holdings = portfolio.holdings.map((holding) => enrichHolding(holding, snapshotMap.get(holding.ticker), spySnapshot));
  const watchlist = portfolio.watchlist.map((item) => enrichWatchlistItem(item, snapshotMap.get(item.ticker)));
  const summary = buildPortfolioSummary(holdings, watchlist);

  return {
    holdings,
    watchlist,
    summary
  };
}

async function addHolding(payload = {}) {
  const ticker = normalizeTicker(payload.ticker);
  const quantity = toPositiveNumber(payload.quantity);
  const averageBuyPrice = toPositiveNumber(payload.averageBuyPrice);
  const investedAmount = toPositiveNumber(payload.investedAmount) || quantity * averageBuyPrice;
  const purchaseDate = String(payload.purchaseDate || '').trim();
  const note = String(payload.note || '').trim();

  if (!ticker) {
    throw new Error('יש להזין סימול מניה');
  }

  if (!quantity) {
    throw new Error('יש להזין כמות חיובית');
  }

  if (!averageBuyPrice) {
    throw new Error('יש להזין מחיר קנייה חיובי');
  }

  if (!purchaseDate) {
    throw new Error('יש להזין תאריך קנייה');
  }

  const portfolio = await readPortfolio();

  // Snapshot SPY's current price at purchase time so excess-return-vs-SPY can be computed later
  // (same pattern as scanHistoryService.js's spyPriceAtScan). Best-effort: if it fails, the holding
  // just won't get the comparison (spyPriceAtPurchase stays null), same as pre-existing holdings.
  let spyPriceAtPurchase = null;
  try {
    const spySnapshot = await marketDataService.getStockSnapshot('SPY');
    const spyPrice = Number(spySnapshot?.price);
    spyPriceAtPurchase = Number.isFinite(spyPrice) && spyPrice > 0 ? spyPrice : null;
  } catch (error) {
    spyPriceAtPurchase = null;
  }

  const newHolding = {
    id: createId('holding'),
    ticker,
    quantity,
    averageBuyPrice,
    investedAmount,
    purchaseDate,
    note,
    spyPriceAtPurchase,
    createdAt: new Date().toISOString()
  };

  portfolio.holdings.unshift(newHolding);
  await writePortfolio(portfolio);

  return getPortfolio();
}

async function removeHolding(id) {
  const portfolio = await readPortfolio();
  portfolio.holdings = portfolio.holdings.filter((holding) => holding.id !== id);
  await writePortfolio(portfolio);

  return getPortfolio();
}

async function addWatchlistItem(payload = {}) {
  const ticker = normalizeTicker(payload.ticker);
  const note = String(payload.note || '').trim();

  if (!ticker) {
    throw new Error('יש להזין סימול למעקב');
  }

  const portfolio = await readPortfolio();
  const exists = portfolio.watchlist.some((item) => item.ticker === ticker);

  if (exists) {
    throw new Error('המניה כבר קיימת ברשימת המעקב');
  }

  portfolio.watchlist.unshift({
    id: createId('watch'),
    ticker,
    note,
    createdAt: new Date().toISOString()
  });
  await writePortfolio(portfolio);

  return getPortfolio();
}

async function removeWatchlistItem(id) {
  const portfolio = await readPortfolio();
  portfolio.watchlist = portfolio.watchlist.filter((item) => item.id !== id);
  await writePortfolio(portfolio);

  return getPortfolio();
}

function enrichHolding(holding, snapshot, spySnapshot) {
  const investedAmount = toPositiveNumber(holding.investedAmount) || holding.quantity * holding.averageBuyPrice;
  const currentPrice = snapshot?.price || 0;
  const currentValue = currentPrice * holding.quantity;
  const gainLossValue = currentValue - investedAmount;
  const gainLossPct = investedAmount > 0 ? (gainLossValue / investedAmount) * 100 : 0;
  const changeFromBuyPricePct = holding.averageBuyPrice
    ? ((currentPrice - holding.averageBuyPrice) / holding.averageBuyPrice) * 100
    : 0;

  // Only holdings added after this feature shipped carry spyPriceAtPurchase - older ones simply
  // get null here (not 0), which the client renders as "-" instead of a misleading 0%.
  let spyReturnPct = null;
  let excessReturnPct = null;
  const spyPriceAtPurchase = Number(holding.spyPriceAtPurchase);
  const currentSpyPrice = Number(spySnapshot?.price);

  if (Number.isFinite(spyPriceAtPurchase) && spyPriceAtPurchase > 0 && Number.isFinite(currentSpyPrice) && currentSpyPrice > 0) {
    spyReturnPct = ((currentSpyPrice - spyPriceAtPurchase) / spyPriceAtPurchase) * 100;
    excessReturnPct = changeFromBuyPricePct - spyReturnPct;
  }

  return {
    ...holding,
    companyName: snapshot?.companyName || holding.ticker,
    sector: snapshot?.sector || 'Unknown',
    source: snapshot?.data_source || 'demo',
    currentPrice: round(currentPrice),
    dailyChange: round(snapshot?.daily_change || 0),
    currentValue: round(currentValue),
    gainLossValue: round(gainLossValue),
    gainLossPct: round(gainLossPct),
    changeFromBuyPricePct: round(changeFromBuyPricePct),
    spyReturnPct: spyReturnPct === null ? null : round(spyReturnPct),
    excessReturnPct: excessReturnPct === null ? null : round(excessReturnPct),
    status: gainLossValue > 0 ? 'profit' : gainLossValue < 0 ? 'loss' : 'flat'
  };
}

function enrichWatchlistItem(item, snapshot) {
  return {
    ...item,
    companyName: snapshot?.companyName || item.ticker,
    sector: snapshot?.sector || 'Unknown',
    source: snapshot?.data_source || 'demo',
    currentPrice: round(snapshot?.price || 0),
    dailyChange: round(snapshot?.daily_change || 0)
  };
}

function buildPortfolioSummary(holdings, watchlist) {
  const totalInvested = holdings.reduce((sum, holding) => sum + holding.investedAmount, 0);
  const totalCurrentValue = holdings.reduce((sum, holding) => sum + holding.currentValue, 0);
  const totalGainLoss = totalCurrentValue - totalInvested;
  const totalGainLossPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;
  const bestHolding = [...holdings].sort((a, b) => b.gainLossPct - a.gainLossPct)[0] || null;
  const worstHolding = [...holdings].sort((a, b) => a.gainLossPct - b.gainLossPct)[0] || null;
  const sectorAllocation = buildSectorAllocation(holdings, totalCurrentValue);

  return {
    holdingsCount: holdings.length,
    watchlistCount: watchlist.length,
    totalInvested: round(totalInvested),
    totalCurrentValue: round(totalCurrentValue),
    totalGainLoss: round(totalGainLoss),
    totalGainLossPct: round(totalGainLossPct),
    bestHolding: bestHolding
      ? {
          ticker: bestHolding.ticker,
          companyName: bestHolding.companyName,
          gainLossPct: bestHolding.gainLossPct
        }
      : null,
    worstHolding: worstHolding
      ? {
          ticker: worstHolding.ticker,
          companyName: worstHolding.companyName,
          gainLossPct: worstHolding.gainLossPct
        }
      : null,
    sectorAllocation
  };
}

function buildSectorAllocation(holdings, totalCurrentValue) {
  const buckets = new Map();

  for (const holding of holdings) {
    const key = holding.sector || 'Unknown';
    const current = buckets.get(key) || 0;
    buckets.set(key, current + holding.currentValue);
  }

  return [...buckets.entries()]
    .map(([sector, currentValue]) => ({
      sector,
      currentValue: round(currentValue),
      weightPct: totalCurrentValue > 0 ? round((currentValue / totalCurrentValue) * 100) : 0
    }))
    .sort((left, right) => right.currentValue - left.currentValue);
}

function uniqueTickers(tickers) {
  return [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  getPortfolio,
  addHolding,
  removeHolding,
  addWatchlistItem,
  removeWatchlistItem
};

const STOCK_UNIVERSE = {
  NASDAQ: [
    ['AAPL', 'Apple', 'Technology'],
    ['MSFT', 'Microsoft', 'Technology'],
    ['NVDA', 'NVIDIA', 'Technology'],
    ['AVGO', 'Broadcom', 'Technology'],
    ['AMGN', 'Amgen', 'Healthcare'],
    ['COST', 'Costco', 'Consumer'],
    ['INTC', 'Intel', 'Technology'],
    ['AMD', 'AMD', 'Technology'],
    ['PEP', 'PepsiCo', 'Consumer'],
    ['CSCO', 'Cisco', 'Technology'],
    ['GILD', 'Gilead', 'Healthcare'],
    ['ADBE', 'Adobe', 'Technology']
  ],
  NYSE: [
    ['JPM', 'JPMorgan Chase', 'Finance'],
    ['XOM', 'Exxon Mobil', 'Energy'],
    ['CVX', 'Chevron', 'Energy'],
    ['V', 'Visa', 'Finance'],
    ['JNJ', 'Johnson & Johnson', 'Healthcare'],
    ['PG', 'Procter & Gamble', 'Consumer'],
    ['HD', 'Home Depot', 'Consumer'],
    ['BAC', 'Bank of America', 'Finance'],
    ['PLTR', 'Palantir', 'Technology'],
    ['KO', 'Coca-Cola', 'Consumer'],
    ['PFE', 'Pfizer', 'Healthcare'],
    ['GS', 'Goldman Sachs', 'Finance']
  ],
  TASE: [
    ['TEVA', 'טבע', 'Healthcare'],
    ['NICE', 'נייס', 'Technology'],
    ['ICL', 'איי.סי.אל', 'Energy'],
    ['POLI', 'בנק הפועלים', 'Finance'],
    ['LEUMI', 'בנק לאומי', 'Finance'],
    ['BEZQ', 'בזק', 'Consumer'],
    ['AZRG', 'אזריאלי', 'Consumer'],
    ['ELBIT', 'אלביט מערכות', 'Technology'],
    ['OPC', 'OPC אנרגיה', 'Energy'],
    ['MZTF', 'מזרחי טפחות', 'Finance'],
    ['PHOE', 'הפניקס', 'Finance'],
    ['STRA', 'שטראוס', 'Consumer']
  ]
};

function getTickerContext(ticker) {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();

  for (const [exchange, entries] of Object.entries(STOCK_UNIVERSE)) {
    const match = entries.find(([symbol]) => symbol === normalizedTicker);

    if (match) {
      return {
        exchange,
        ticker: match[0],
        companyName: match[1],
        sector: match[2]
      };
    }
  }

  return {
    exchange: 'NASDAQ',
    ticker: normalizedTicker,
    companyName: normalizedTicker,
    sector: 'Unknown'
  };
}

module.exports = {
  STOCK_UNIVERSE,
  getTickerContext
};

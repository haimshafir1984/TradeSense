const NASDAQ_UNIVERSE = [
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
  ['ADBE', 'Adobe', 'Technology'],
  ['AMZN', 'Amazon', 'Consumer'],
  ['META', 'Meta Platforms', 'Technology'],
  ['NFLX', 'Netflix', 'Technology'],
  ['TSLA', 'Tesla', 'Consumer'],
  ['QCOM', 'Qualcomm', 'Technology'],
  ['TXN', 'Texas Instruments', 'Technology'],
  ['ADP', 'Automatic Data Processing', 'Technology'],
  ['CMCSA', 'Comcast', 'Consumer'],
  ['INTU', 'Intuit', 'Technology'],
  ['AMAT', 'Applied Materials', 'Technology'],
  ['SBUX', 'Starbucks', 'Consumer'],
  ['BKNG', 'Booking Holdings', 'Consumer']
];

const NYSE_UNIVERSE = [
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
  ['GS', 'Goldman Sachs', 'Finance'],
  ['WMT', 'Walmart', 'Consumer'],
  ['DIS', 'Walt Disney', 'Consumer'],
  ['MCD', "McDonald's", 'Consumer'],
  ['CAT', 'Caterpillar', 'Industrial'],
  ['UNH', 'UnitedHealth', 'Healthcare'],
  ['GE', 'GE Aerospace', 'Industrial'],
  ['IBM', 'IBM', 'Technology'],
  ['AXP', 'American Express', 'Finance'],
  ['BLK', 'BlackRock', 'Finance'],
  ['BA', 'Boeing', 'Industrial'],
  ['DE', 'Deere & Company', 'Industrial'],
  ['SCHW', 'Charles Schwab', 'Finance'],
  ['T', 'AT&T', 'Technology']
];

const TASE_UNIVERSE = [
  ['TEVA', 'Teva', 'Healthcare'],
  ['NICE', 'NICE', 'Technology'],
  ['ICL', 'ICL', 'Energy'],
  ['POLI', 'Bank Hapoalim', 'Finance'],
  ['LEUMI', 'Bank Leumi', 'Finance'],
  ['BEZQ', 'Bezeq', 'Consumer'],
  ['AZRG', 'Azrieli Group', 'Consumer'],
  ['ELBIT', 'Elbit Systems', 'Technology'],
  ['OPC', 'OPC Energy', 'Energy'],
  ['MZTF', 'Mizrahi Tefahot', 'Finance'],
  ['PHOE', 'Phoenix Holdings', 'Finance'],
  ['STRA', 'Strauss Group', 'Consumer'],
  ['TSEM', 'Tower Semiconductor', 'Technology'],
  ['CAMT', 'Camtek', 'Technology'],
  ['ENLT', 'Enlight Renewable Energy', 'Energy'],
  ['DLEKG', 'Delek Group', 'Energy'],
  ['MGDL', 'Migdal Holdings', 'Finance'],
  ['FIBI', 'First International Bank', 'Finance'],
  ['DSCT', 'Discount Bank', 'Finance'],
  ['ALHE', 'Alony Hetz', 'Consumer'],
  ['FOX', 'Fox Wizel', 'Consumer'],
  ['AMOT', 'Amot Investments', 'Consumer'],
  ['MLSR', 'Melisron', 'Consumer']
];

const STOCK_UNIVERSE = {
  NASDAQ: NASDAQ_UNIVERSE.slice(0, 20),
  NYSE: NYSE_UNIVERSE.slice(0, 20),
  TASE: TASE_UNIVERSE.slice(0, 20)
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

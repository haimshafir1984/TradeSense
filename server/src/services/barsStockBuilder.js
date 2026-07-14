// Builds a full stock object (same field contract as every FMP/Finnhub-backed stock) from raw
// Alpaca daily bars. Extracted from smallCapUniverseService.js so marketDataService.js's
// Alpaca+Nasdaq path (docs/SPEC_PROVIDER_REBALANCE.md section 5.4/5.5) can reuse the exact same
// technical-indicator math instead of duplicating it. Provider-agnostic: callers pass in their own
// `dataSource` label and candidate metadata (symbol/companyName/sector/marketCap) since those come
// from whichever screener/profile source is upstream (Nasdaq, FMP, etc).
const { average, scoreConsolidation } = require('./mathUtils');

// bars is oldest-to-newest (alpacaService contract).
function buildStockFromBars({ exchange, candidate, bars, dataSource }) {
  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const price = Number(last?.c);
  const previousClose = Number(previous?.c);

  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return null;
  }

  const closes = bars.map((bar) => Number(bar.c)).filter(Number.isFinite);
  const highs = bars.map((bar) => Number(bar.h)).filter(Number.isFinite);
  const lows = bars.map((bar) => Number(bar.l)).filter(Number.isFinite);
  const volumes = bars.map((bar) => Number(bar.v)).filter(Number.isFinite);
  const imputedFields = [];

  const dailyChange = ((price - previousClose) / previousClose) * 100;
  const lastOpen = Number(last?.o);
  const gapPct = Number.isFinite(lastOpen) ? ((lastOpen - previousClose) / previousClose) * 100 : 0;

  const last20 = bars.slice(-20);
  const adrValues = last20
    .filter((bar) => Number.isFinite(bar.h) && Number.isFinite(bar.l) && bar.l > 0)
    .map((bar) => ((bar.h - bar.l) / bar.l) * 100);
  const adrPct = adrValues.length ? average(adrValues) : 0;

  const volume = Number(last?.v) || 0;
  const averageVolume30d = volumes.length ? average(volumes.slice(-30)) : 0;

  const high52w = highs.length ? Math.max(...highs) : price;
  const low52w = lows.length ? Math.min(...lows) : price;

  const last50Closes = closes.slice(-50);
  if (last50Closes.length < 50) {
    imputedFields.push('MA50');
  }
  const ma50 = last50Closes.length ? average(last50Closes) : price;

  const last200Closes = closes.slice(-200);
  if (last200Closes.length < 200) {
    imputedFields.push('MA200');
  }
  const ma200 = last200Closes.length ? average(last200Closes) : price;

  const previousMa50 = average(closes.slice(-55, -5)) || ma50;
  const ma50Slope = previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0;

  const returns = closes.slice(1).map((value, index) => (closes[index] ? (value - closes[index]) / closes[index] : 0));
  const volatility = standardDeviation(returns.slice(-20));

  const return3m = computeReturnPctFromEnd(closes, 63);

  const lastHigh = Number(last?.h);
  const priceNearDailyHigh = Number.isFinite(lastHigh) && lastHigh > 0 ? price / lastHigh : 0.9;

  // No fundamentals available from bars alone - flagged as imputed rather than fabricated. Callers
  // with a fundamentals source (e.g. Finnhub profile enrichment) overwrite these afterward.
  imputedFields.push('revenue_growth_pct', 'dividend_yield');

  return {
    ticker: candidate.symbol,
    companyName: candidate.companyName,
    sector: candidate.sector,
    exchange,
    price,
    daily_change: dailyChange,
    gap_pct: gapPct,
    volume,
    average_volume_30d: averageVolume30d,
    market_cap: candidate.marketCap,
    dividend_yield: 0,
    MA50: ma50,
    MA200: ma200,
    high_52w: high52w,
    low_52w: low52w,
    volatility,
    return_3m: Number.isFinite(return3m) ? return3m : 0,
    revenue_growth_pct: 0,
    adr_pct: adrPct,
    ma50_slope: ma50Slope,
    price_near_daily_high: priceNearDailyHigh,
    consolidation_score: scoreConsolidation(closes.slice(-20), high52w, low52w),
    data_source: dataSource,
    imputedFields
  };
}

function standardDeviation(values) {
  const filtered = values.filter(Number.isFinite);
  if (!filtered.length) {
    return 0;
  }

  const mean = average(filtered);
  const variance = average(filtered.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

// closes is oldest-to-newest; anchor ~63 trading days back from the latest close.
function computeReturnPctFromEnd(closes, windowDays) {
  const price = closes[closes.length - 1];
  const anchor = closes[closes.length - 1 - windowDays];
  return Number.isFinite(anchor) && anchor > 0 && Number.isFinite(price) ? ((price - anchor) / anchor) * 100 : NaN;
}

module.exports = {
  buildStockFromBars
};

const { STOCK_UNIVERSE } = require('../data/universe');

function getExchangeSymbols(exchange) {
  return STOCK_UNIVERSE[exchange] || STOCK_UNIVERSE.NASDAQ;
}

async function getMarketData(exchange) {
  const entries = getExchangeSymbols(exchange);
  const mode = (process.env.DATA_MODE || 'fmp').toLowerCase();

  console.log(`[marketData] Requested exchange=${exchange} mode=${mode} symbols=${entries.length}`);

  if (mode === 'fmp' && process.env.FMP_API_KEY) {
    const result = await getFmpData(exchange, entries);
    if (result) {
      return result;
    }
  } else if (mode === 'fmp' && !process.env.FMP_API_KEY) {
    console.warn('[marketData] DATA_MODE=fmp but FMP_API_KEY is missing. Falling back to demo data.');
  }

  if (mode === 'finnhub' && process.env.FINNHUB_API_KEY) {
    const result = await getFinnhubData(exchange, entries);
    if (result) {
      return result;
    }
  } else if (mode === 'finnhub' && !process.env.FINNHUB_API_KEY) {
    console.warn('[marketData] DATA_MODE=finnhub but FINNHUB_API_KEY is missing. Falling back to demo data.');
  }

  const demoStocks = entries.map(([ticker, companyName, sector]) =>
    createDemoStock(exchange, ticker, companyName, sector)
  );

  console.log(`[marketData] Using demo data. exchange=${exchange} count=${demoStocks.length}`);
  return {
    stocks: demoStocks,
    source: 'demo'
  };
}

async function getFmpData(exchange, entries) {
  const apiKey = process.env.FMP_API_KEY;
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);

  const stocks = await Promise.all(
    entries.map(([ticker, companyName, sector]) => getBestEffortFmpStock(exchange, ticker, companyName, sector, apiKey, fromDate, toDate))
  );

  const availableStocks = stocks.filter(Boolean);
  const allDemo = availableStocks.every((stock) => stock.data_source === 'demo');
  const allLive = availableStocks.length > 0 && availableStocks.every((stock) => stock.data_source === 'fmp');

  if (availableStocks.length > 0 && !allDemo) {
    const source = allLive ? 'fmp' : 'fmp_partial';
    console.log(`[marketData] Using ${source} data. exchange=${exchange} count=${availableStocks.length}`);
    return {
      stocks: availableStocks,
      source
    };
  }

  console.warn(`[marketData] No usable FMP live data available for exchange=${exchange}. Falling back to demo.`);
  return null;
}

async function getBestEffortFmpStock(exchange, ticker, companyName, fallbackSector, apiKey, fromDate, toDate) {
  const [quoteResult, profileResult, historyResult] = await Promise.all([
    fetchJson(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${apiKey}`, `fmp-quote:${ticker}`, true),
    fetchJson(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${apiKey}`, `fmp-profile:${ticker}`, true),
    fetchJson(
      `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${fromDate}&to=${toDate}&apikey=${apiKey}`,
      `fmp-history:${ticker}`,
      true
    )
  ]);

  const quote = firstArrayItem(quoteResult.ok ? quoteResult.data : null);
  const profile = firstArrayItem(profileResult.ok ? profileResult.data : null);
  const historyItems = normalizeFmpHistory(historyResult.ok ? historyResult.data : null);

  if (!quote && !profile && historyItems.length === 0) {
    console.warn(`[marketData] ${ticker} has no accessible FMP data. Using demo stock.`);
    return {
      ...createDemoStock(exchange, ticker, companyName, fallbackSector),
      data_source: 'demo'
    };
  }

  const closes = historyItems.map((item) => item.close).filter(Number.isFinite);
  const volumes = historyItems.map((item) => item.volume).filter(Number.isFinite);
  const latestHistory = historyItems[0] || null;
  const latestClose = latestHistory?.close || seededNumber(`${ticker}-price`, 18, 460);
  const price = positiveOrDefault(quote?.price, latestClose);
  const previousClose = positiveOrDefault(quote?.previousClose, historyItems[1]?.close || price * 0.97);
  const dayHigh = positiveOrDefault(quote?.dayHigh, latestHistory?.high || price);
  const volume = positiveOrDefault(quote?.volume, latestHistory?.volume || seededNumber(`${ticker}-vol`, 500000, 6500000));
  const averageVolume30d = average(volumes.slice(0, 30)) || seededNumber(`${ticker}-avg`, 350000, 5200000);
  const ma50 = average(closes.slice(0, 50)) || price * seededNumber(`${ticker}-ma50`, 0.92, 1.06);
  const ma200 = average(closes.slice(0, 200)) || price * seededNumber(`${ticker}-ma200`, 0.84, 1.1);
  const previousMa50 = average(closes.slice(5, 55)) || ma50;
  const returns = closes.slice(0, 20).map((value, index) => {
    const nextValue = closes[index + 1];
    return nextValue ? (value - nextValue) / nextValue : 0;
  });
  const volatility = standardDeviation(returns) || seededNumber(`${ticker}-volatility`, 0.015, 0.07);
  const high52 = positiveOrDefault(quote?.yearHigh, Math.max(...closes, price));
  const low52 = positiveOrDefault(quote?.yearLow, Math.min(...closes, price));
  const marketCap = positiveOrDefault(quote?.marketCap, positiveOrDefault(profile?.mktCap, seededNumber(`${ticker}-cap`, 900, 220000) * 1000000));
  const dailyChange = Number.isFinite(quote?.changesPercentage)
    ? Number(quote.changesPercentage)
    : price && previousClose
      ? ((price - previousClose) / previousClose) * 100
      : 0;
  const sector = profile?.sector || fallbackSector;
  const dividendYield = positiveOrDefault(profile?.lastDiv, seededNumber(`${ticker}-div`, 0, 4.2));
  const hasCoreLiveData = Boolean(quote || profile);
  const hasHistory = historyItems.length >= 30;
  const dataSource = hasCoreLiveData && hasHistory ? 'fmp' : 'fmp_partial';

  if (dataSource === 'fmp_partial') {
    console.log(`[marketData] ${ticker} using partial FMP data. quote=${Boolean(quote)} profile=${Boolean(profile)} history=${historyItems.length}`);
  }

  return {
    ticker,
    companyName: profile?.companyName || quote?.name || companyName,
    sector,
    exchange,
    price,
    daily_change: dailyChange,
    volume,
    average_volume_30d: averageVolume30d,
    market_cap: marketCap,
    dividend_yield: dividendYield,
    MA50: ma50,
    MA200: ma200,
    high_52w: high52,
    low_52w: low52,
    volatility,
    institutional_inflow: seededNumber(`${ticker}-inst`, -4, 9),
    insider_transactions: seededNumber(`${ticker}-insider`, -2, 6),
    price_near_daily_high: dayHigh ? price / dayHigh : 0.9,
    ma50_slope: previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0,
    consolidation_score: scoreConsolidation(closes.slice(0, 20), high52, low52),
    data_source: dataSource
  };
}

async function getFinnhubData(exchange, entries) {
  const stocks = await Promise.all(
    entries.map(([ticker, companyName, sector]) => getBestEffortFinnhubStock(exchange, ticker, companyName, sector))
  );

  const availableStocks = stocks.filter(Boolean);
  const allDemo = availableStocks.every((stock) => stock.data_source === 'demo');
  const allLive = availableStocks.length > 0 && availableStocks.every((stock) => stock.data_source === 'finnhub');

  if (availableStocks.length > 0 && !allDemo) {
    const source = allLive ? 'finnhub' : 'finnhub_partial';
    console.log(`[marketData] Using ${source} data. exchange=${exchange} count=${availableStocks.length}`);
    return {
      stocks: availableStocks,
      source
    };
  }

  console.warn(`[marketData] No usable Finnhub live data available for exchange=${exchange}. Falling back to demo.`);
  return null;
}

async function getBestEffortFinnhubStock(exchange, ticker, companyName, fallbackSector) {
  const apiKey = process.env.FINNHUB_API_KEY;
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 24 * 60 * 60;

  const [quoteResult, profileResult, metricsResult, candlesResult] = await Promise.all([
    fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`, `quote:${ticker}`, true),
    fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${apiKey}`, `profile2:${ticker}`, true),
    fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${apiKey}`, `metric:${ticker}`, true),
    fetchJson(
      `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${now}&token=${apiKey}`,
      `candle:${ticker}`,
      true
    )
  ]);

  const quote = quoteResult.ok ? quoteResult.data : null;
  const profile = profileResult.ok ? profileResult.data : null;
  const metrics = metricsResult.ok ? metricsResult.data : null;
  const candles = candlesResult.ok ? candlesResult.data : null;

  if (!quote && !profile) {
    console.warn(`[marketData] ${ticker} has no accessible live quote/profile data. Using demo stock.`);
    return {
      ...createDemoStock(exchange, ticker, companyName, fallbackSector),
      data_source: 'demo'
    };
  }

  const candleCloses = candles && candles.s === 'ok' && Array.isArray(candles.c)
    ? candles.c.filter((value) => Number.isFinite(value))
    : [];
  const candleVolumes = candles && candles.s === 'ok' && Array.isArray(candles.v)
    ? candles.v.filter((value) => Number.isFinite(value))
    : [];

  const fallbackPrice = seededNumber(`${ticker}-price`, 18, 460);
  const price = positiveOrDefault(quote?.c, candleCloses[candleCloses.length - 1] || fallbackPrice);
  const previousClose = positiveOrDefault(quote?.pc, price * 0.97);
  const dailyHigh = positiveOrDefault(quote?.h, price);
  const volume = candleVolumes[candleVolumes.length - 1] || seededNumber(`${ticker}-vol`, 500000, 6500000);
  const averageVolume30d = average(candleVolumes.slice(-30)) || seededNumber(`${ticker}-avg`, 350000, 5200000);
  const ma50 = average(candleCloses.slice(-50)) || price * seededNumber(`${ticker}-ma50`, 0.92, 1.06);
  const ma200 = average(candleCloses.slice(-200)) || price * seededNumber(`${ticker}-ma200`, 0.84, 1.1);
  const previousMa50 = average(candleCloses.slice(-55, -5)) || ma50;
  const returns = candleCloses.slice(1).map((value, index) =>
    candleCloses[index] ? (value - candleCloses[index]) / candleCloses[index] : 0
  );
  const volatility = standardDeviation(returns.slice(-20)) || seededNumber(`${ticker}-volatility`, 0.015, 0.07);
  const high52 = positiveOrDefault(metrics?.metric?.['52WeekHigh'], Math.max(...candleCloses, price));
  const low52 = positiveOrDefault(metrics?.metric?.['52WeekLow'], Math.min(...candleCloses, price));
  const marketCapMillions = positiveOrDefault(
    profile?.marketCapitalization || metrics?.metric?.marketCapitalization,
    seededNumber(`${ticker}-cap`, 900, 220000)
  );
  const dailyChange = Number.isFinite(quote?.dp)
    ? Number(quote.dp)
    : price && previousClose
      ? ((price - previousClose) / previousClose) * 100
      : 0;
  const hasCoreLiveData = quoteResult.ok || profileResult.ok || metricsResult.ok;
  const hasFullTechnicalData = candlesResult.ok;
  const dataSource = hasCoreLiveData && hasFullTechnicalData ? 'finnhub' : 'finnhub_partial';

  if (dataSource === 'finnhub_partial') {
    console.log(`[marketData] ${ticker} using partial Finnhub data. quote=${quoteResult.ok} profile=${profileResult.ok} metric=${metricsResult.ok} candle=${candlesResult.ok}`);
  }

  return {
    ticker,
    companyName: profile?.name || companyName,
    sector: profile?.finnhubIndustry || fallbackSector,
    exchange,
    price,
    daily_change: dailyChange,
    volume,
    average_volume_30d: averageVolume30d,
    market_cap: marketCapMillions * 1000000,
    dividend_yield: positiveOrDefault(metrics?.metric?.dividendYieldIndicatedAnnual, seededNumber(`${ticker}-div`, 0, 4.2)),
    MA50: ma50,
    MA200: ma200,
    high_52w: high52,
    low_52w: low52,
    volatility,
    institutional_inflow: seededNumber(`${ticker}-inst`, -4, 9),
    insider_transactions: seededNumber(`${ticker}-insider`, -2, 6),
    price_near_daily_high: dailyHigh ? price / dailyHigh : 0.9,
    ma50_slope: previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0,
    consolidation_score: scoreConsolidation(candleCloses.slice(-20), high52, low52),
    data_source: dataSource
  };
}

async function fetchJson(url, label, allowFailure = false) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Request failed: ${response.status} body=${body}`);
      if (allowFailure) {
        console.warn(`[marketData] ${label} unavailable: ${error.message}`);
        return { ok: false, error };
      }
      throw error;
    }

    return {
      ok: true,
      data: await response.json()
    };
  } catch (error) {
    if (allowFailure) {
      console.warn(`[marketData] ${label} unavailable: ${error.message}`);
      return { ok: false, error };
    }
    throw error;
  }
}

function normalizeFmpHistory(payload) {
  if (Array.isArray(payload)) {
    return payload.map(normalizeFmpHistoryItem).filter(Boolean);
  }

  if (Array.isArray(payload?.historical)) {
    return payload.historical.map(normalizeFmpHistoryItem).filter(Boolean);
  }

  return [];
}

function normalizeFmpHistoryItem(item) {
  if (!item) {
    return null;
  }

  const close = Number(item.close);
  const high = Number(item.high);
  const low = Number(item.low);
  const volume = Number(item.volume);

  if (!Number.isFinite(close)) {
    return null;
  }

  return {
    close,
    high: Number.isFinite(high) ? high : close,
    low: Number.isFinite(low) ? low : close,
    volume: Number.isFinite(volume) ? volume : 0
  };
}

function firstArrayItem(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function createDemoStock(exchange, ticker, companyName, sector) {
  const price = seededNumber(`${exchange}-${ticker}-price`, 12, 420);
  const averageVolume30d = seededNumber(`${exchange}-${ticker}-avg`, 180000, 5200000);
  const volume = averageVolume30d * seededNumber(`${exchange}-${ticker}-volume`, 0.65, 2.9);
  const dailyChange = seededNumber(`${exchange}-${ticker}-change`, -3.2, 9.6);
  const marketCap = seededNumber(`${exchange}-${ticker}-cap`, 500, 320000) * 1000000;
  const high52 = price * seededNumber(`${exchange}-${ticker}-high52`, 1.03, 1.2);
  const low52 = price * seededNumber(`${exchange}-${ticker}-low52`, 0.48, 0.9);
  const ma50 = price * seededNumber(`${exchange}-${ticker}-ma50`, 0.88, 1.08);
  const ma200 = price * seededNumber(`${exchange}-${ticker}-ma200`, 0.78, 1.14);

  return {
    ticker,
    companyName,
    sector,
    exchange,
    price,
    daily_change: dailyChange,
    volume,
    average_volume_30d: averageVolume30d,
    market_cap: marketCap,
    dividend_yield: seededNumber(`${exchange}-${ticker}-dividend`, 0, 5.4),
    MA50: ma50,
    MA200: ma200,
    high_52w: high52,
    low_52w: low52,
    volatility: seededNumber(`${exchange}-${ticker}-volatility`, 0.012, 0.08),
    institutional_inflow: seededNumber(`${exchange}-${ticker}-institutional`, -5, 11),
    insider_transactions: seededNumber(`${exchange}-${ticker}-insider`, -3, 8),
    price_near_daily_high: seededNumber(`${exchange}-${ticker}-dailyhigh`, 0.84, 1),
    ma50_slope: seededNumber(`${exchange}-${ticker}-slope`, -0.04, 0.09),
    consolidation_score: seededNumber(`${exchange}-${ticker}-consolidation`, 0.25, 0.97),
    data_source: 'demo'
  };
}

function scoreConsolidation(closes, high52, low52) {
  if (!closes.length) {
    return 0.5;
  }

  const localHigh = Math.max(...closes);
  const localLow = Math.min(...closes);
  const range = localHigh && localLow ? (localHigh - localLow) / localHigh : 0.1;
  const yearlyRange = high52 && low52 ? (high52 - low52) / high52 : 0.25;

  return clamp(1 - range / Math.max(yearlyRange, 0.08));
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

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));

  if (!filtered.length) {
    return 0;
  }

  return filtered.reduce((total, value) => total + value, 0) / filtered.length;
}

function seededNumber(seed, min, max) {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }

  const normalized = Math.abs(Math.sin(hash) * 10000) % 1;
  return min + normalized * (max - min);
}

function positiveOrDefault(value, fallback) {
  return Number(value) > 0 ? Number(value) : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

module.exports = {
  getMarketData
};
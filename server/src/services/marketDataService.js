const { STOCK_UNIVERSE, getTickerContext } = require('../data/universe');
const { clamp, average, scoreConsolidation } = require('./mathUtils');

const REQUEST_CACHE = new Map();
const MARKET_DATA_CACHE = new Map();
const SNAPSHOT_CACHE = new Map();

const REQUEST_CACHE_TTL_MS = 10 * 60 * 1000;
const MARKET_DATA_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;

const EXCHANGE_SUFFIXES = {
  TASE: '.TA'
};

function getExchangeSymbols(exchange) {
  return STOCK_UNIVERSE[exchange] || STOCK_UNIVERSE.NASDAQ;
}

function getProviderSymbol(exchange, ticker) {
  const suffix = EXCHANGE_SUFFIXES[exchange];
  return suffix ? `${ticker}${suffix}` : ticker;
}

// The static universe (~20 hand-picked mega-caps per exchange) is the ceiling on what the scoring
// logic can ever recommend - it can't surface a stock that isn't on the list, and the mega-cap
// bias undermines the short-horizon strategies in particular. This queries FMP's screener for an
// actively-traded, liquid slice of the exchange instead; on any failure it returns null and the
// caller falls back to the static list. See docs/LOGIC_IMPROVEMENTS.md 5.3.
const FMP_SCREENER_EXCHANGES = new Set(['NASDAQ', 'NYSE']);
// Bigger universe = better odds of finding gap-and-go / short-horizon candidates (see
// watchlistService.js), at the cost of ~4 extra FMP calls per added symbol per scan (quote,
// profile, history, growth) - watch FMP rate limits if raising this further. Configurable via env
// since the right tradeoff depends on the API plan in use.
const DYNAMIC_UNIVERSE_SIZE = Number(process.env.FMP_UNIVERSE_SIZE) || 40;

async function getDynamicUniverse(exchange, apiKey) {
  if (!FMP_SCREENER_EXCHANGES.has(exchange)) {
    return null;
  }

  const url = `https://financialmodelingprep.com/stable/company-screener?exchange=${exchange}&isActivelyTrading=true&limit=${DYNAMIC_UNIVERSE_SIZE}&apikey=${apiKey}`;
  const result = await fetchJson(url, `fmp-screener:${exchange}`, true);

  if (!result.ok || !Array.isArray(result.data) || !result.data.length) {
    return null;
  }

  const entries = result.data
    .filter((item) => item?.symbol && item?.companyName)
    .slice(0, DYNAMIC_UNIVERSE_SIZE)
    .map((item) => [item.symbol, item.companyName, item.sector || 'Unknown']);

  return entries.length ? entries : null;
}

async function getMarketData(exchange) {
  const mode = (process.env.DATA_MODE || 'fmp').toLowerCase();
  const cacheKey = `${mode}:${exchange}`;

  const cachedMarketData = readCache(MARKET_DATA_CACHE, cacheKey);
  if (cachedMarketData) {
    console.log(`[marketData] Using cached market data. exchange=${exchange} mode=${mode} symbols=${cachedMarketData.stocks.length}`);
    return cachedMarketData;
  }

  let entries = getExchangeSymbols(exchange);
  console.log(`[marketData] Requested exchange=${exchange} mode=${mode} symbols=${entries.length}`);

  if (mode === 'fmp' && process.env.FMP_API_KEY) {
    const dynamicEntries = await getDynamicUniverse(exchange, process.env.FMP_API_KEY);
    if (dynamicEntries) {
      entries = dynamicEntries;
      console.log(`[marketData] Using dynamic FMP screener universe. exchange=${exchange} count=${entries.length}`);
    }

    const result = await getFmpData(exchange, entries);
    if (result) {
      writeCache(MARKET_DATA_CACHE, cacheKey, result, MARKET_DATA_CACHE_TTL_MS);
      return result;
    }
  } else if (mode === 'fmp' && !process.env.FMP_API_KEY) {
    console.warn('[marketData] DATA_MODE=fmp but FMP_API_KEY is missing. Falling back to demo data.');
  }

  if (mode === 'finnhub' && process.env.FINNHUB_API_KEY) {
    const result = await getFinnhubData(exchange, entries);
    if (result) {
      writeCache(MARKET_DATA_CACHE, cacheKey, result, MARKET_DATA_CACHE_TTL_MS);
      return result;
    }
  } else if (mode === 'finnhub' && !process.env.FINNHUB_API_KEY) {
    console.warn('[marketData] DATA_MODE=finnhub but FINNHUB_API_KEY is missing. Falling back to demo data.');
  }

  const demoStocks = entries.map(([ticker, companyName, sector]) =>
    createDemoStock(exchange, ticker, companyName, sector)
  );

  console.log(`[marketData] Using demo data. exchange=${exchange} count=${demoStocks.length}`);
  const demoResult = {
    stocks: demoStocks,
    source: 'demo'
  };
  writeCache(MARKET_DATA_CACHE, cacheKey, demoResult, MARKET_DATA_CACHE_TTL_MS);
  return demoResult;
}

async function getStockSnapshot(ticker) {
  const context = getTickerContext(ticker);
  const mode = (process.env.DATA_MODE || 'fmp').toLowerCase();
  const cacheKey = `${mode}:${context.exchange}:${context.ticker}`;

  const cachedSnapshot = readCache(SNAPSHOT_CACHE, cacheKey);
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  if (mode === 'fmp' && process.env.FMP_API_KEY) {
    const to = new Date();
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    const snapshot = await getBestEffortFmpStock(
      context.exchange,
      context.ticker,
      context.companyName,
      context.sector,
      process.env.FMP_API_KEY,
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10)
    );

    if (snapshot) {
      writeCache(SNAPSHOT_CACHE, cacheKey, snapshot, SNAPSHOT_CACHE_TTL_MS);
      return snapshot;
    }
  }

  if (mode === 'finnhub' && process.env.FINNHUB_API_KEY) {
    const snapshot = await getBestEffortFinnhubStock(
      context.exchange,
      context.ticker,
      context.companyName,
      context.sector
    );

    if (snapshot) {
      writeCache(SNAPSHOT_CACHE, cacheKey, snapshot, SNAPSHOT_CACHE_TTL_MS);
      return snapshot;
    }
  }

  const demoSnapshot = createDemoStock(context.exchange, context.ticker, context.companyName, context.sector);
  writeCache(SNAPSHOT_CACHE, cacheKey, demoSnapshot, SNAPSHOT_CACHE_TTL_MS);
  return demoSnapshot;
}

async function getStockSnapshots(tickers = []) {
  return Promise.all(tickers.map((ticker) => getStockSnapshot(ticker)));
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

  console.warn(`[marketData] No usable FMP live data available for exchange=${exchange}. Falling back to demo. If this exchange requires a provider symbol suffix, check EXCHANGE_SUFFIXES.`);
  return null;
}

async function getBestEffortFmpStock(exchange, ticker, companyName, fallbackSector, apiKey, fromDate, toDate) {
  const providerSymbol = getProviderSymbol(exchange, ticker);
  const [quoteResult, profileResult, historyResult, growthResult] = await Promise.all([
    fetchJson(`https://financialmodelingprep.com/stable/quote?symbol=${providerSymbol}&apikey=${apiKey}`, `fmp-quote:${providerSymbol}`, true),
    fetchJson(`https://financialmodelingprep.com/stable/profile?symbol=${providerSymbol}&apikey=${apiKey}`, `fmp-profile:${providerSymbol}`, true),
    fetchJson(
      `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${providerSymbol}&from=${fromDate}&to=${toDate}&apikey=${apiKey}`,
      `fmp-history:${providerSymbol}`,
      true
    ),
    fetchJson(
      `https://financialmodelingprep.com/stable/income-statement-growth?symbol=${providerSymbol}&limit=1&apikey=${apiKey}`,
      `fmp-growth:${providerSymbol}`,
      true
    )
  ]);

  const quote = firstArrayItem(quoteResult.ok ? quoteResult.data : null);
  const profile = firstArrayItem(profileResult.ok ? profileResult.data : null);
  const historyItems = normalizeFmpHistory(historyResult.ok ? historyResult.data : null);
  const growth = firstArrayItem(growthResult.ok ? growthResult.data : null);

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
  const imputedFields = [];

  const price = trackedValue(imputedFields, 'price', [Number(quote?.price), Number(latestHistory?.close)], () =>
    seededNumber(`${ticker}-price`, 18, 460));
  const previousClose = positiveOrDefault(quote?.previousClose, historyItems[1]?.close || price * 0.97);
  const dayHigh = positiveOrDefault(quote?.dayHigh, latestHistory?.high || price);
  const volume = trackedValue(imputedFields, 'volume', [Number(quote?.volume), Number(latestHistory?.volume)], () =>
    seededNumber(`${ticker}-vol`, 500000, 6500000));
  const averageVolume30d = trackedValue(imputedFields, 'average_volume_30d', [average(volumes.slice(0, 30))], () =>
    seededNumber(`${ticker}-avg`, 350000, 5200000));
  const ma50 = trackedValue(imputedFields, 'MA50', [average(closes.slice(0, 50))], () =>
    price * seededNumber(`${ticker}-ma50`, 0.92, 1.06));
  const ma200 = trackedValue(imputedFields, 'MA200', [average(closes.slice(0, 200))], () =>
    price * seededNumber(`${ticker}-ma200`, 0.84, 1.1));
  const previousMa50 = average(closes.slice(5, 55)) || ma50;
  // `volatility` is the standard deviation of daily returns over the last ~20 trading days,
  // expressed as a fraction (0.03 = 3% typical daily move) - NOT annualized, NOT ATR%. Every
  // threshold that reads it (matchesVolatility, risk-fit taper, riskOverlay) assumes this same
  // definition; if a future change swaps in ATR% or an annualized figure, all of those need
  // re-tuning together. See docs/LOGIC_IMPROVEMENTS.md section 4.
  const returns = closes.slice(0, 20).map((value, index) => {
    const nextValue = closes[index + 1];
    return nextValue ? (value - nextValue) / nextValue : 0;
  });
  const volatility = trackedValue(imputedFields, 'volatility', [standardDeviation(returns)], () =>
    seededNumber(`${ticker}-volatility`, 0.015, 0.07));
  const high52 = trackedValue(imputedFields, 'high_52w', [Number(quote?.yearHigh), closes.length ? Math.max(...closes, price) : NaN], () => price * 1.1);
  const low52 = trackedValue(imputedFields, 'low_52w', [Number(quote?.yearLow), closes.length ? Math.min(...closes, price) : NaN], () => price * 0.85);
  const marketCap = trackedValue(imputedFields, 'market_cap', [Number(quote?.marketCap), Number(profile?.mktCap)], () =>
    seededNumber(`${ticker}-cap`, 900, 220000) * 1000000);
  const return3m = trackedSignedValue(imputedFields, 'return_3m', [computeReturnPct(closes, price)], () =>
    ma200 > 0 ? ((price - ma200) / ma200) * 100 : 0);
  // Real fundamental growth (revenue YoY), not the market-cap-as-"growth" proxy strategies.js used
  // to rely on. Falls back to a neutral 0% (no known signal) rather than a fabricated value.
  const revenueGrowthPct = trackedSignedValue(
    imputedFields,
    'revenue_growth_pct',
    [Number.isFinite(Number(growth?.growthRevenue)) ? Number(growth.growthRevenue) * 100 : NaN],
    () => 0
  );
  // Average Daily Range % and gap % - the core signals for swing/episodic-pivot momentum styles
  // (see strategies.js#scoreSwingMomentumStrategy). See docs/LOGIC_IMPROVEMENTS.md.
  const adrPct = trackedValue(imputedFields, 'adr_pct', [computeAvgDailyRangePct(historyItems.slice(0, 20))], () =>
    seededNumber(`${ticker}-adr`, 1.5, 6));
  const gapPct = trackedSignedValue(imputedFields, 'gap_pct', [computeGapPct(historyItems)], () => 0);
  const dailyChange = Number.isFinite(quote?.changesPercentage)
    ? Number(quote.changesPercentage)
    : price && previousClose
      ? ((price - previousClose) / previousClose) * 100
      : 0;
  const sector = profile?.sector || fallbackSector;
  const dividendPerShare = Number(profile?.lastDiv);
  const dividendYield = Number.isFinite(dividendPerShare) && dividendPerShare > 0 && price > 0
    ? (dividendPerShare / price) * 100
    : 0;
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
    return_3m: return3m,
    revenue_growth_pct: revenueGrowthPct,
    adr_pct: adrPct,
    gap_pct: gapPct,
    price_near_daily_high: dayHigh ? price / dayHigh : 0.9,
    ma50_slope: previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0,
    consolidation_score: scoreConsolidation(closes.slice(0, 20), high52, low52),
    data_source: dataSource,
    imputedFields
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

  console.warn(`[marketData] No usable Finnhub live data available for exchange=${exchange}. Falling back to demo. If this exchange requires a provider symbol suffix, check EXCHANGE_SUFFIXES.`);
  return null;
}

async function getBestEffortFinnhubStock(exchange, ticker, companyName, fallbackSector) {
  const apiKey = process.env.FINNHUB_API_KEY;
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 24 * 60 * 60;
  const providerSymbol = getProviderSymbol(exchange, ticker);

  const [quoteResult, profileResult, metricsResult, candlesResult] = await Promise.all([
    fetchJson(`https://finnhub.io/api/v1/quote?symbol=${providerSymbol}&token=${apiKey}`, `quote:${providerSymbol}`, true),
    fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${providerSymbol}&token=${apiKey}`, `profile2:${providerSymbol}`, true),
    fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${providerSymbol}&metric=all&token=${apiKey}`, `metric:${providerSymbol}`, true),
    fetchJson(
      `https://finnhub.io/api/v1/stock/candle?symbol=${providerSymbol}&resolution=D&from=${from}&to=${now}&token=${apiKey}`,
      `candle:${providerSymbol}`,
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

  const imputedFields = [];
  const price = trackedValue(imputedFields, 'price', [Number(quote?.c), candleCloses[candleCloses.length - 1]], () =>
    seededNumber(`${ticker}-price`, 18, 460));
  const previousClose = positiveOrDefault(quote?.pc, price * 0.97);
  const dailyHigh = positiveOrDefault(quote?.h, price);
  const volume = trackedValue(imputedFields, 'volume', [candleVolumes[candleVolumes.length - 1]], () =>
    seededNumber(`${ticker}-vol`, 500000, 6500000));
  const averageVolume30d = trackedValue(imputedFields, 'average_volume_30d', [average(candleVolumes.slice(-30))], () =>
    seededNumber(`${ticker}-avg`, 350000, 5200000));
  const ma50 = trackedValue(imputedFields, 'MA50', [average(candleCloses.slice(-50))], () =>
    price * seededNumber(`${ticker}-ma50`, 0.92, 1.06));
  const ma200 = trackedValue(imputedFields, 'MA200', [average(candleCloses.slice(-200))], () =>
    price * seededNumber(`${ticker}-ma200`, 0.84, 1.1));
  const previousMa50 = average(candleCloses.slice(-55, -5)) || ma50;
  const returns = candleCloses.slice(1).map((value, index) =>
    candleCloses[index] ? (value - candleCloses[index]) / candleCloses[index] : 0
  );
  const volatility = trackedValue(imputedFields, 'volatility', [standardDeviation(returns.slice(-20))], () =>
    seededNumber(`${ticker}-volatility`, 0.015, 0.07));
  const high52 = trackedValue(imputedFields, 'high_52w', [Number(metrics?.metric?.['52WeekHigh']), candleCloses.length ? Math.max(...candleCloses, price) : NaN], () => price * 1.1);
  const low52 = trackedValue(imputedFields, 'low_52w', [Number(metrics?.metric?.['52WeekLow']), candleCloses.length ? Math.min(...candleCloses, price) : NaN], () => price * 0.85);
  const marketCapMillions = trackedValue(
    imputedFields,
    'market_cap',
    [Number(profile?.marketCapitalization), Number(metrics?.metric?.marketCapitalization)],
    () => seededNumber(`${ticker}-cap`, 900, 220000)
  );
  const return3m = trackedSignedValue(
    imputedFields,
    'return_3m',
    [computeReturnPctFromEnd(candleCloses, price, RETURN_WINDOW_TRADING_DAYS)],
    () => (ma200 > 0 ? ((price - ma200) / ma200) * 100 : 0)
  );
  const revenueGrowthPct = trackedSignedValue(
    imputedFields,
    'revenue_growth_pct',
    [Number(metrics?.metric?.revenueGrowthTTMYoy)],
    () => 0
  );
  const rawCandleHighs = candles && candles.s === 'ok' && Array.isArray(candles.h) ? candles.h : [];
  const rawCandleLows = candles && candles.s === 'ok' && Array.isArray(candles.l) ? candles.l : [];
  const rawCandleOpens = candles && candles.s === 'ok' && Array.isArray(candles.o) ? candles.o : [];
  const rawCandleCloses = candles && candles.s === 'ok' && Array.isArray(candles.c) ? candles.c : [];
  const adrPct = trackedValue(imputedFields, 'adr_pct', [computeAvgDailyRangePctFromArrays(rawCandleHighs, rawCandleLows, 20)], () =>
    seededNumber(`${ticker}-adr`, 1.5, 6));
  const gapPct = trackedSignedValue(imputedFields, 'gap_pct', [computeGapPctFromArrays(rawCandleOpens, rawCandleCloses)], () => 0);
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
    dividend_yield: positiveOrDefault(metrics?.metric?.dividendYieldIndicatedAnnual, 0),
    MA50: ma50,
    MA200: ma200,
    high_52w: high52,
    low_52w: low52,
    volatility,
    return_3m: return3m,
    revenue_growth_pct: revenueGrowthPct,
    adr_pct: adrPct,
    gap_pct: gapPct,
    price_near_daily_high: dailyHigh ? price / dailyHigh : 0.9,
    ma50_slope: previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0,
    consolidation_score: scoreConsolidation(candleCloses.slice(-20), high52, low52),
    data_source: dataSource,
    imputedFields
  };
}

async function fetchJson(url, label, allowFailure = false) {
  const cachedResponse = readCache(REQUEST_CACHE, url);
  if (cachedResponse) {
    return {
      ok: true,
      data: cachedResponse
    };
  }

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

    const parsed = await response.json();
    writeCache(REQUEST_CACHE, url, parsed, REQUEST_CACHE_TTL_MS);

    return {
      ok: true,
      data: parsed
    };
  } catch (error) {
    if (allowFailure) {
      console.warn(`[marketData] ${label} unavailable: ${error.message}`);
      return { ok: false, error };
    }
    throw error;
  }
}

function readCache(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function writeCache(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
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
  const open = Number(item.open);
  const volume = Number(item.volume);

  if (!Number.isFinite(close)) {
    return null;
  }

  return {
    close,
    high: Number.isFinite(high) ? high : close,
    low: Number.isFinite(low) ? low : close,
    open: Number.isFinite(open) ? open : close,
    volume: Number.isFinite(volume) ? volume : 0
  };
}

// Average Daily Range % over the given (most-recent-first) history slice - the core "does this
// stock actually move" gate for swing/momentum styles (see scoreSwingMomentumStrategy).
function computeAvgDailyRangePct(historyItems) {
  const ranges = historyItems
    .filter((item) => Number.isFinite(item.high) && Number.isFinite(item.low) && item.low > 0)
    .map((item) => ((item.high - item.low) / item.low) * 100);
  return ranges.length ? average(ranges) : NaN;
}

// historyItems is most-recent-first (FMP): [0] is the latest session, [1] is the one before it.
function computeGapPct(historyItems) {
  const latestOpen = Number(historyItems[0]?.open);
  const previousClose = Number(historyItems[1]?.close);
  return Number.isFinite(latestOpen) && Number.isFinite(previousClose) && previousClose > 0
    ? ((latestOpen - previousClose) / previousClose) * 100
    : NaN;
}

// Same as computeAvgDailyRangePct, but for raw oldest-to-newest candle arrays (Finnhub).
function computeAvgDailyRangePctFromArrays(highs, lows, count) {
  const n = Math.min(count, highs.length, lows.length);
  const ranges = [];
  for (let index = highs.length - n; index < highs.length; index += 1) {
    const high = Number(highs[index]);
    const low = Number(lows[index]);
    if (Number.isFinite(high) && Number.isFinite(low) && low > 0) {
      ranges.push(((high - low) / low) * 100);
    }
  }
  return ranges.length ? average(ranges) : NaN;
}

// opens/closes are oldest-to-newest (Finnhub): the last entries are the latest session.
function computeGapPctFromArrays(opens, closes) {
  const latestOpen = Number(opens[opens.length - 1]);
  const previousClose = Number(closes[closes.length - 2]);
  return Number.isFinite(latestOpen) && Number.isFinite(previousClose) && previousClose > 0
    ? ((latestOpen - previousClose) / previousClose) * 100
    : NaN;
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
    return_3m: ma200 > 0 ? ((price - ma200) / ma200) * 100 : 0,
    revenue_growth_pct: seededNumber(`${exchange}-${ticker}-revgrowth`, -8, 25),
    adr_pct: seededNumber(`${exchange}-${ticker}-adr`, 1, 8),
    gap_pct: seededNumber(`${exchange}-${ticker}-gap`, -3, 12),
    price_near_daily_high: seededNumber(`${exchange}-${ticker}-dailyhigh`, 0.84, 1),
    ma50_slope: seededNumber(`${exchange}-${ticker}-slope`, -0.04, 0.09),
    consolidation_score: seededNumber(`${exchange}-${ticker}-consolidation`, 0.25, 0.97),
    data_source: 'demo',
    imputedFields: []
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

function trackedValue(tracker, fieldName, candidates, computeFallback) {
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  tracker.push(fieldName);
  return computeFallback();
}

// Like trackedValue, but for fields that are legitimately negative (e.g. returns), where a
// simple positivity check would wrongly treat "down 5%" as missing data.
function trackedSignedValue(tracker, fieldName, candidates, computeFallback) {
  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) {
      return candidate;
    }
  }

  tracker.push(fieldName);
  return computeFallback();
}

// ~63 trading days ≈ 3 calendar months; history arrays are ordered most-recent-first.
const RETURN_WINDOW_TRADING_DAYS = 63;

function computeReturnPct(closes, price) {
  const anchor = closes[RETURN_WINDOW_TRADING_DAYS];
  return Number.isFinite(anchor) && anchor > 0 ? ((price - anchor) / anchor) * 100 : NaN;
}

// Finnhub candle arrays are ordered oldest-to-newest, the reverse of the FMP history array.
function computeReturnPctFromEnd(closes, price, windowDays) {
  const anchor = closes[closes.length - 1 - windowDays];
  return Number.isFinite(anchor) && anchor > 0 ? ((price - anchor) / anchor) * 100 : NaN;
}

module.exports = {
  getMarketData,
  getStockSnapshot,
  getStockSnapshots,
  // Exported for reuse by smallCapUniverseService.js (its own FMP screener call needs the same
  // caching/error-handling fetchJson already provides, and its universe scoring needs the same
  // consolidation-range heuristic every other provider path uses) - see
  // docs/SPEC_SMALL_CAP_STRATEGY.md section 2.1/2.2.
  fetchJson,
  scoreConsolidation
};

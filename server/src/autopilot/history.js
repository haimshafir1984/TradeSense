const store = require("./store");
const alpaca = require("../providers/alpacaService");
const market = require("./market");
const { computeFeaturesFromBars } = require("../playbooks/features");

const SCHEMA = "v1";
const INTRADAY_WINDOW_MS = 26 * 86400000;
const INTRADAY_OVERLAP_MS = 10 * 60000;
const MAX_INTRADAY_SYMBOLS = 500;
const IN_FLIGHT = new Map();

function cacheKey({ symbol, feed, timeframe, adjustment = "split" }) {
  return `${SCHEMA}:${symbol}:${feed}:${timeframe}:${adjustment}`;
}

function getRecord(key) {
  return store.get("history", key);
}

function putRecord(key, record) {
  return store.put("history", key, record);
}

function uniqueBars(bars) {
  const byTime = new Map();
  for (const bar of bars || []) {
    if (bar?.t) byTime.set(bar.t, bar);
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function previousSessionDate(now = Date.now()) {
  return market.nyDate(now - 16 * 60 * 60 * 1000);
}

function dailyCacheUsable(cached, now) {
  const today = market.nyDate(now);
  return (
    cached?.feed === "sip" &&
    Array.isArray(cached.bars) &&
    cached.bars.length &&
    market.nyDate(Date.parse(cached.fetchedAt || 0)) === today &&
    cached.lastSessionDate < today
  );
}

function intradayCacheUsable(cached, now) {
  return (
    cached?.feed === "iex" &&
    cached?.timeframe === "5Min" &&
    cached.watermarkAt &&
    cached.sessionDate === market.nyDate(now)
  );
}

async function once(key, fn) {
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);
  const promise = fn().finally(() => IN_FLIGHT.delete(key));
  IN_FLIGHT.set(key, promise);
  return promise;
}

async function ensureDailyFeatures(symbols, now = Date.now()) {
  const unique = [...new Set(symbols)].filter(Boolean);
  const result = new Map();
  const missing = [];

  for (const symbol of unique) {
    const key = cacheKey({ symbol, feed: "sip", timeframe: "1Day" });
    const cached = getRecord(key);
    const bars = cached?.bars || [];
    if (dailyCacheUsable(cached, now)) {
      result.set(symbol, { features: computeFeaturesFromBars(bars), bars, cached: true });
    } else {
      missing.push(symbol);
    }
  }

  if (!missing.length) {
    return { features: result, complete: true, failedSymbols: [], errors: [], cacheHits: unique.length };
  }

  const sortedMissing = [...missing].sort();
  const detail = await once(`daily:${sortedMissing.join(",")}:${market.nyDate(now)}`, () =>
    alpaca.getBarsDetailed({
      symbols: sortedMissing,
      timeframe: "1Day",
      days: 420,
      feed: "sip",
      adjustment: "split",
      now,
    }),
  );

  const failed = new Set(detail.failedSymbols || []);
  for (const symbol of missing) {
    if (failed.has(symbol)) continue;
    const bars = uniqueBars(detail.bars.get(symbol) || []);
    const closed = bars.filter((bar) => market.nyDate(Date.parse(bar.t)) < market.nyDate(now));
    if (!closed.length) continue;
    const lastSessionDate = market.nyDate(Date.parse(closed.at(-1).t));
    const record = {
      symbol,
      feed: "sip",
      timeframe: "1Day",
      adjustment: "split",
      schema: SCHEMA,
      bars: closed,
      lastSessionDate,
      fetchedAt: new Date(now).toISOString(),
    };
    putRecord(cacheKey({ symbol, feed: "sip", timeframe: "1Day" }), record);
    result.set(symbol, { features: computeFeaturesFromBars(closed), bars: closed, cached: false });
  }

  return {
    features: result,
    complete: detail.complete,
    failedSymbols: detail.failedSymbols,
    errors: detail.errors,
    cacheHits: unique.length - missing.length,
  };
}

async function ensureIntradayBars(symbols, { now = Date.now(), keepSymbols = [] } = {}) {
  const unique = [...new Set(symbols)].filter(Boolean);
  const result = new Map();
  const missing = [];
  let cacheHits = 0;
  const end = new Date(now).toISOString();

  for (const symbol of unique) {
    const key = cacheKey({ symbol, feed: "iex", timeframe: "5Min" });
    const cached = getRecord(key);
    if (intradayCacheUsable(cached, now)) {
      const startMs = Math.max(Date.parse(cached.watermarkAt) - INTRADAY_OVERLAP_MS, now - INTRADAY_WINDOW_MS);
      missing.push({ symbol, start: new Date(startMs).toISOString(), cached });
      cacheHits += 1;
    } else {
      missing.push({
        symbol,
        start: new Date(now - INTRADAY_WINDOW_MS).toISOString(),
        cached: null,
      });
    }
  }

  const byStart = new Map();
  for (const item of missing) {
    if (!byStart.has(item.start)) byStart.set(item.start, []);
    byStart.get(item.start).push(item.symbol);
  }

  let complete = true;
  const failedSymbols = [];
  const errors = [];

  for (const [start, group] of byStart) {
    const detail = await once(`intraday:${start}:${end}:${group.sort().join(",")}`, () =>
      alpaca.getBarsDetailed({
        symbols: group,
        timeframe: "5Min",
        start,
        end,
        feed: "iex",
        adjustment: "split",
        now,
      }),
    );
    if (!detail.complete) complete = false;
    failedSymbols.push(...detail.failedSymbols);
    errors.push(...detail.errors);
    for (const symbol of group) {
      const key = cacheKey({ symbol, feed: "iex", timeframe: "5Min" });
      const cached = getRecord(key);
      const baseBars = intradayCacheUsable(cached, now) ? cached.bars || [] : [];
      const merged = uniqueBars([...baseBars, ...(detail.bars.get(symbol) || [])]).filter(
        (bar) => Date.parse(bar.t) >= now - INTRADAY_WINDOW_MS,
      );
      if (!detail.failedSymbols.includes(symbol)) {
        const record = {
          symbol,
          feed: "iex",
          timeframe: "5Min",
          adjustment: "split",
          schema: SCHEMA,
          bars: merged,
          watermarkAt: end,
          lastBarAt: merged.at(-1)?.t || cached?.lastBarAt || null,
          fetchedAt: new Date(now).toISOString(),
          lastUsedAt: new Date(now).toISOString(),
          sessionDate: market.nyDate(now),
        };
        putRecord(key, record);
        result.set(symbol, merged);
      } else {
        result.set(symbol, intradayCacheUsable(cached, now) ? cached?.bars || [] : []);
      }
    }
  }

  for (const symbol of unique) {
    if (!result.has(symbol)) {
      const cached = getRecord(cacheKey({ symbol, feed: "iex", timeframe: "5Min" }));
      result.set(symbol, cached?.bars || []);
    }
  }

  evictIntraday({ now, keepSymbols });
  return { bars: result, complete, failedSymbols, errors, cacheHits };
}

function evictIntraday({ now = Date.now(), keepSymbols = [] } = {}) {
  const keep = new Set(keepSymbols);
  const records = store
    .list("history")
    .filter((record) => record?.feed === "iex" && record?.timeframe === "5Min")
    .map((record) => ({ ...record, usedMs: Date.parse(record.lastUsedAt || record.fetchedAt || 0) || 0 }))
    .sort((a, b) => b.usedMs - a.usedMs);
  const staleBefore = now - 7 * 86400000;
  const victims = [];
  for (const record of records) {
    if (!keep.has(record.symbol) && record.usedMs < staleBefore) victims.push(record);
  }
  for (const record of records.slice(MAX_INTRADAY_SYMBOLS)) {
    if (!keep.has(record.symbol)) victims.push(record);
  }
  for (const record of victims) {
    store.remove("history", cacheKey({ symbol: record.symbol, feed: "iex", timeframe: "5Min" }));
  }
}

function cachedIntradayBars(symbols, now = Date.now()) {
  const result = new Map();
  for (const symbol of [...new Set(symbols)].filter(Boolean)) {
    const cached = getRecord(cacheKey({ symbol, feed: "iex", timeframe: "5Min" }));
    if (intradayCacheUsable(cached, now)) result.set(symbol, cached.bars || []);
  }
  return result;
}

module.exports = {
  cacheKey,
  ensureDailyFeatures,
  ensureIntradayBars,
  previousSessionDate,
  dailyCacheUsable,
  intradayCacheUsable,
  cachedIntradayBars,
  uniqueBars,
};

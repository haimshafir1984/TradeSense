const store = require("./store");
const market = require("./market");
const alpaca = require("../providers/alpacaService");
const { logMemory } = require("../memoryDiagnostics");

const MAX_UNIVERSE = Number(process.env.AUTOPILOT_UNIVERSE_MAX || 2000);
const HISTORY_BATCH_SIZE = Math.min(
  100,
  Math.max(20, Number(process.env.AUTOPILOT_UNIVERSE_BATCH_SIZE || 75) || 75),
);
const MIN_PRICE = 5;
const MIN_AVG_DOLLAR_VOLUME_20D = 2_000_000;
let lastAttemptAt = 0;
let runningPromise = null;

function validSymbol(symbol) {
  return typeof symbol === "string" && /^[A-Z]{1,5}$/.test(symbol);
}

function avgDollarVolume20d(bars) {
  const window = (bars || [])
    .filter((bar) => Number(bar?.c) > 0 && Number(bar?.v) >= 0)
    .slice(-20);
  if (window.length < 20) return null;
  return window.reduce((sum, bar) => sum + Number(bar.c) * Number(bar.v), 0) / window.length;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function activeAssets() {
  const rows = [];
  for (const exchange of ["NASDAQ", "NYSE"]) {
    const assets = await alpaca.getActiveAssets({ exchange });
    for (const asset of assets || []) {
      if (validSymbol(asset.symbol)) rows.push({ ...asset, companyName: asset.name || asset.symbol, exchange });
    }
  }
  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
  }
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function cached() {
  return store.get("cache", "v3-universe");
}

function getRows(now = Date.now()) {
  const date = market.nyDate(now);
  const cache = cached();
  if (cache?.date === date && Array.isArray(cache.rows)) return cache.rows;
  return Array.isArray(cache?.rows) ? cache.rows : [];
}

async function build(now = Date.now()) {
  const date = market.nyDate(now);
  logMemory("universe:start");
  const assets = await activeAssets();
  logMemory("universe:assets-ready");
  const diagnostics = {
    date,
    startedAt: new Date(now).toISOString(),
    sourceAssets: assets.length,
    invalidSymbol: 0,
    missingDaily: 0,
    insufficientSessions: 0,
    belowPrice: 0,
    belowLiquidity: 0,
    capped: 0,
    partialData: false,
    errors: [],
  };

  const rows = [];
  const historyBatches = chunks(assets, HISTORY_BATCH_SIZE);
  for (let batchIndex = 0; batchIndex < historyBatches.length; batchIndex += 1) {
    const assetBatch = historyBatches[batchIndex];
    const detail = await alpaca.getBarsDetailed({
      symbols: assetBatch.map((asset) => asset.symbol),
      timeframe: "1Day",
      days: 40,
      feed: "sip",
      adjustment: "split",
      now,
    });
    diagnostics.partialData ||= !detail.complete;
    diagnostics.errors.push(...(detail.errors || []));

    for (const asset of assetBatch) {
      if (!validSymbol(asset.symbol)) {
        diagnostics.invalidSymbol += 1;
        continue;
      }
      const bars = (detail.bars.get(asset.symbol) || []).filter(
        (bar) => market.nyDate(Date.parse(bar.t)) < date,
      );
      if (!bars.length) {
        diagnostics.missingDaily += 1;
        continue;
      }
      if (bars.length < 20) {
        diagnostics.insufficientSessions += 1;
        continue;
      }
      const last = bars.at(-1);
      const close = Number(last.c);
      if (!Number.isFinite(close) || close < MIN_PRICE) {
        diagnostics.belowPrice += 1;
        continue;
      }
      const adv20 = avgDollarVolume20d(bars);
      if (!Number.isFinite(adv20) || adv20 < MIN_AVG_DOLLAR_VOLUME_20D) {
        diagnostics.belowLiquidity += 1;
        continue;
      }
      rows.push({
        symbol: asset.symbol,
        companyName: asset.companyName || asset.name || asset.symbol,
        exchange: asset.exchange,
        close,
        avgDollarVolume20d: adv20,
        dailyFeed: "sip",
        lastSessionDate: market.nyDate(Date.parse(last.t)),
        fetchedAt: new Date(now).toISOString(),
      });
    }

    // Give V8 a turn between batches so completed response bodies can be reclaimed
    // before the next Alpaca response is parsed.
    await new Promise((resolve) => setImmediate(resolve));
    if ((batchIndex + 1) % 20 === 0) logMemory(`universe:batch-${batchIndex + 1}`);
  }

  rows.sort(
    (left, right) =>
      right.avgDollarVolume20d - left.avgDollarVolume20d || left.symbol.localeCompare(right.symbol),
  );
  diagnostics.eligibleBeforeCap = rows.length;
  const capped = rows.slice(0, MAX_UNIVERSE);
  diagnostics.capped = Math.max(0, rows.length - capped.length);
  diagnostics.completedAt = new Date().toISOString();
  diagnostics.complete = !diagnostics.partialData;
  store.put("cache", "v3-universe", { date, rows: capped, diagnostics });
  logMemory("universe:complete");
  return capped;
}

async function ensure(now = Date.now(), { background = false } = {}) {
  const date = market.nyDate(now);
  const cache = cached();
  if (cache?.date === date && cache.rows?.length && cache.diagnostics?.complete !== false) return cache.rows;
  if (runningPromise) return background ? getRows(now) : runningPromise;
  if (Date.now() - lastAttemptAt < 300000) return getRows(now);
  lastAttemptAt = Date.now();
  runningPromise = build(now).finally(() => {
    runningPromise = null;
  });
  return background ? getRows(now) : runningPromise;
}

function status(now = Date.now()) {
  const cache = cached();
  return {
    ready: Boolean(cache?.rows?.length),
    date: cache?.date || null,
    stale: cache?.date !== market.nyDate(now),
    size: cache?.rows?.length || 0,
    diagnostics: cache?.diagnostics || null,
    running: Boolean(runningPromise),
  };
}

module.exports = {
  ensure,
  getRows,
  status,
  avgDollarVolume20d,
  validSymbol,
};

const store = require("./store");
const market = require("./market");
const alpaca = require("../providers/alpacaService");

const MAX_UNIVERSE = Number(process.env.AUTOPILOT_UNIVERSE_MAX || 2000);
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
  const assets = await activeAssets();
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
  const symbols = assets.map((asset) => asset.symbol);
  const detail = await alpaca.getBarsDetailed({
    symbols,
    timeframe: "1Day",
    days: 40,
    feed: "sip",
    adjustment: "split",
    now,
  });
  diagnostics.partialData = !detail.complete;
  diagnostics.errors = detail.errors || [];

  for (const asset of assets) {
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

  rows.sort(
    (left, right) =>
      right.avgDollarVolume20d - left.avgDollarVolume20d || left.symbol.localeCompare(right.symbol),
  );
  diagnostics.eligibleBeforeCap = rows.length;
  const capped = rows.slice(0, MAX_UNIVERSE);
  diagnostics.capped = Math.max(0, rows.length - capped.length);
  diagnostics.completedAt = new Date().toISOString();
  diagnostics.complete = detail.complete;
  store.put("cache", "v3-universe", { date, rows: capped, diagnostics });
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

const store = require("./store");
const market = require("./market");
const alpaca = require("../providers/alpacaService");
const { logMemory } = require("../memoryDiagnostics");

const parsedUniverseMax = Number(process.env.AUTOPILOT_UNIVERSE_MAX || 2000);
const MAX_UNIVERSE = Number.isFinite(parsedUniverseMax) ? Math.min(5000, Math.max(1, Math.floor(parsedUniverseMax))) : 2000;
const PROFILE = process.env.AUTOPILOT_SCAN_PROFILE === "legacy" ? "legacy" : "balanced";
const BUCKETS = ["lower_liquidity", "medium_liquidity", "high_liquidity"];
const HISTORY_BATCH_SIZE = Math.min(10, Math.max(1, Number(process.env.AUTOPILOT_UNIVERSE_BATCH_SIZE || 10) || 10));
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

function quotas(maximum = MAX_UNIVERSE) {
  const weights = [30, 40, 30];
  const raw = weights.map((weight) => maximum * weight / 100);
  const result = raw.map(Math.floor);
  let remainder = maximum - result.reduce((sum, value) => sum + value, 0);
  raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .slice(0, remainder).forEach(({ index }) => { result[index] += 1; });
  return Object.fromEntries(BUCKETS.map((key, index) => [key, result[index]]));
}

function liquidityBucket(adv) {
  if (adv < 20_000_000) return BUCKETS[0];
  if (adv < 100_000_000) return BUCKETS[1];
  return BUCKETS[2];
}

function stratify(rows, maximum = MAX_UNIVERSE, cursors = {}) {
  const limits = quotas(maximum);
  const grouped = Object.fromEntries(BUCKETS.map((key) => [key, []]));
  for (const row of rows) grouped[liquidityBucket(row.avgDollarVolume20d)].push(row);
  for (const key of BUCKETS) grouped[key].sort((a, b) => b.avgDollarVolume20d - a.avgDollarVolume20d || a.symbol.localeCompare(b.symbol));
  const selected = [], perBucket = {};
  for (const key of BUCKETS) {
    const quota = limits[key];
    const topCount = Math.floor(quota * 0.8);
    const group = grouped[key];
    const rest = group.slice(Math.min(topCount, group.length)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const cursor = Number.isInteger(cursors[key]) && cursors[key] >= 0 ? cursors[key] : 0;
    const rotatedCount = Math.min(Math.max(0, quota - topCount), rest.length);
    const rotated = Array.from({ length: rotatedCount }, (_, i) => rest[(cursor + i) % rest.length]);
    const chosen = [...group.slice(0, Math.min(topCount, group.length)), ...rotated];
    selected.push(...chosen);
    perBucket[key] = { eligible: group.length, selected: chosen.length, rotated: rotated.length, excluded: Math.max(0, group.length - chosen.length) };
  }
  // Redistribute unfilled capacity round-robin in lower→medium→high order.
  let extra = maximum - selected.length;
  const used = new Set(selected.map((row) => row.symbol));
  const extras = Object.fromEntries(BUCKETS.map((key) => [key, grouped[key].filter((row) => !used.has(row.symbol))]));
  while (extra > 0) {
    let moved = false;
    for (const key of BUCKETS) {
      const row = extras[key].shift();
      if (!row) continue;
      selected.push(row); used.add(row.symbol); perBucket[key].selected += 1; perBucket[key].excluded -= 1; moved = true;
      if (--extra === 0) break;
    }
    if (!moved) break;
  }
  const nextCursors = { ...cursors };
  for (const key of BUCKETS) {
    const remainder = grouped[key].slice(Math.floor(limits[key] * 0.8)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (remainder.length) nextCursors[key] = ((Number(cursors[key]) || 0) + perBucket[key].rotated) % remainder.length;
  }
  return { rows: selected.slice(0, maximum), perBucket, nextCursors, quotas: limits };
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
    partialData: assets.length === 0,
    errors: assets.length === 0 ? [{ kind: "asset_provider_empty" }] : [],
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
  if (PROFILE === "balanced") {
    const state = store.get("runtime", "universe-cursors") || { values: {}, date: null };
    const partition = stratify(rows, MAX_UNIVERSE, state.values);
    diagnostics.perBucket = partition.perBucket;
    diagnostics.quotas = partition.quotas;
    diagnostics.generation = (cached()?.generation || 0) + 1;
    diagnostics.sessionDate = date;
    diagnostics.capped = Math.max(0, rows.length - partition.rows.length);
    diagnostics.complete = !diagnostics.partialData;
    diagnostics.completedAt = new Date().toISOString();
    if (!diagnostics.complete) {
      store.put("cache", "v3-universe-build-diagnostics", diagnostics);
      return getRows(now);
    }
    store.put("cache", "v3-universe", { date, generation: diagnostics.generation, rows: partition.rows, diagnostics });
    // A daily cursor advances exactly once, only after successful publication.
    if (state.date !== date) store.put("runtime", "universe-cursors", { date, values: partition.nextCursors });
    logMemory("universe:complete");
    return partition.rows;
  }
  const capped = rows.slice(0, MAX_UNIVERSE);
  diagnostics.capped = Math.max(0, rows.length - capped.length);
  diagnostics.completedAt = new Date().toISOString();
  diagnostics.complete = !diagnostics.partialData;
  if (diagnostics.complete) store.put("cache", "v3-universe", { date, rows: capped, diagnostics });
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
  quotas,
  liquidityBucket,
  stratify,
};

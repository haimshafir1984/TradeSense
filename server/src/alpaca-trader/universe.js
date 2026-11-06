// Independent universe for the Alpaca arm: its own price/liquidity gates, its own cache. Does not call
// autopilot/universe.js and is not affected by AUTOPILOT_BROKER_ONLY - that filter is specific to the
// Colmex symbol map and must never reach this universe (its whole point is stocks Colmex doesn't offer).
const store = require("../autopilot/store");
const market = require("../autopilot/market");
const alpaca = require("../providers/alpacaService");

const KIND = "alpacaTrader";
// Lowered from 400 after a production OOM crash loop (2026-11-03): this engine's universe build runs
// concurrently with the main autopilot engine's own daily rebuild, inside the same 1.5GB container
// limit, and together they exceeded it (exit 137 / SIGKILL). A smaller universe means a smaller burst.
const MAX_UNIVERSE = Number(process.env.ALPACA_TRADER_UNIVERSE_MAX || 150);
const BATCH_SIZE = 50;
// Self-contained guard, independent of autopilot/memoryDiagnostics.js (whose 350MB "optional" threshold
// is calibrated for an old 512MB host and only pauses optional work, not the core build - too low to be
// useful here, and changing it would affect the Colmex/MT4 side too). Aborts the build early rather
// than letting Docker's hard 1.5GB cgroup limit kill the whole container.
const MEMORY_GUARD_MB = Number(process.env.ALPACA_TRADER_MEMORY_GUARD_MB || 900);
function overMemoryGuard() {
  return process.memoryUsage().rss / (1024 * 1024) >= MEMORY_GUARD_MB;
}

// Bump when the ranking rules change so a universe cached earlier the same day is rebuilt with the new rules.
const RANK_VERSION = 3;

function validSymbol(symbol) {
  return typeof symbol === "string" && /^[A-Z]{1,5}$/.test(symbol);
}

function avgDollarVolume20d(bars) {
  const window = (bars || []).filter((bar) => Number(bar?.c) > 0 && Number(bar?.v) >= 0).slice(-20);
  if (window.length < 20) return null;
  return window.reduce((sum, bar) => sum + Number(bar.c) * Number(bar.v), 0) / window.length;
}

// Average (high - low) / close over the last 20 daily bars: how much a stock typically moves in a day.
function avgRangePct20(bars) {
  const window = (bars || []).filter((bar) => Number(bar?.c) > 0 && Number(bar?.h) >= Number(bar?.l)).slice(-20);
  if (window.length < 20) return null;
  return window.reduce((sum, bar) => sum + (Number(bar.h) - Number(bar.l)) / Number(bar.c), 0) / window.length;
}

async function activeAssets() {
  const rows = [];
  for (const exchange of ["NASDAQ", "NYSE"]) {
    const assets = await alpaca.getActiveAssets({ exchange });
    for (const asset of assets || []) if (validSymbol(asset.symbol)) rows.push({ symbol: asset.symbol, name: asset.name, exchange });
  }
  const bySymbol = new Map();
  for (const row of rows) if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
  return [...bySymbol.values()];
}

// The intraday scan reads IEX candles, and IEX volume is only a few percent of the consolidated (SIP) volume the
// daily average above is built from. Comparing the two made relative volume ~0.03 for every stock, so the
// rvol>=1.2/1.5 strategies could never match (2026-11-05: 0 matches all session). Keep an IEX-based 20-day average
// volume per universe stock so today's IEX volume is compared with IEX history (same units).
async function attachIexVolume(rows, date, now) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    try {
      const detail = await alpaca.getBarsDetailed({ symbols: batch.map((r) => r.symbol), timeframe: "1Day", days: 30, feed: "iex", adjustment: "split", now });
      for (const row of batch) {
        const bars = (detail.bars.get(row.symbol) || []).filter((bar) => market.nyDate(Date.parse(bar.t)) < date).slice(-20);
        const volumes = bars.map((bar) => Number(bar.v)).filter((v) => Number.isFinite(v) && v >= 0);
        row.avgIexVolume20d = volumes.length >= 10 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null;
      }
      detail.bars.clear();
    } catch {
      for (const row of batch) row.avgIexVolume20d = null;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function build(now = Date.now(), profile) {
  const date = market.nyDate(now);
  const assets = await activeAssets();
  const rows = [];
  const diagnostics = { date, sourceAssets: assets.length, belowPrice: 0, belowLiquidity: 0, aboveLiquidity: 0, missing: 0, memoryGuardStopped: false };
  for (let offset = 0; offset < assets.length; offset += BATCH_SIZE) {
    if (overMemoryGuard()) {
      diagnostics.memoryGuardStopped = true;
      console.warn(`[alpaca-trader] universe build stopped early at ${offset}/${assets.length}: RSS over ${MEMORY_GUARD_MB}MB guard`);
      break;
    }
    const batch = assets.slice(offset, offset + BATCH_SIZE);
    const detail = await alpaca.getBarsDetailed({ symbols: batch.map((a) => a.symbol), timeframe: "1Day", days: 30, feed: "sip", adjustment: "split", now });
    for (const asset of batch) {
      const bars = (detail.bars.get(asset.symbol) || []).filter((bar) => market.nyDate(Date.parse(bar.t)) < date);
      if (!bars.length) { diagnostics.missing += 1; continue; }
      const last = bars.at(-1);
      const close = Number(last.c);
      if (!Number.isFinite(close) || close < profile.minPrice) { diagnostics.belowPrice += 1; continue; }
      const adv20 = avgDollarVolume20d(bars);
      if (!Number.isFinite(adv20) || adv20 < profile.minAdv20) { diagnostics.belowLiquidity += 1; continue; }
      if (Number(profile.maxAdv20) > 0 && adv20 > profile.maxAdv20) { diagnostics.aboveLiquidity += 1; continue; }
      rows.push({ symbol: asset.symbol, close, avgDollarVolume20d: adv20, avgRangePct20: avgRangePct20(bars) ?? 0 });
    }
    detail.bars.clear();
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The most volatile names first (not the most liquid, which would pick the mega-caps).
  rows.sort((a, b) => b.avgRangePct20 - a.avgRangePct20 || b.avgDollarVolume20d - a.avgDollarVolume20d);
  const capped = rows.slice(0, MAX_UNIVERSE);
  await attachIexVolume(capped, date, now);
  diagnostics.eligible = rows.length;
  diagnostics.capped = Math.max(0, rows.length - capped.length);
  // Even a guard-stopped (partial) universe is cached and used: it's a real, if incomplete, result -
  // better than an empty scan, and never worse than what a crash loop gave (nothing).
  store.put(KIND, "universe", { rankVersion: RANK_VERSION, date, rows: capped, diagnostics, fetchedAt: new Date(now).toISOString() });
  return capped;
}

function getRows(now = Date.now()) {
  const cache = store.get(KIND, "universe");
  return cache?.date === market.nyDate(now) && cache.rankVersion === RANK_VERSION ? cache.rows : [];
}

function status(now = Date.now()) {
  const cache = store.get(KIND, "universe");
  return { ready: Boolean(cache?.rows?.length), date: cache?.date || null, stale: cache?.date !== market.nyDate(now) || cache?.rankVersion !== RANK_VERSION, size: cache?.rows?.length || 0, diagnostics: cache?.diagnostics || null };
}

module.exports = { build, getRows, status, overMemoryGuard };

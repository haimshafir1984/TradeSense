// Independent universe for the Alpaca arm: its own price/liquidity gates, its own cache. Does not call
// autopilot/universe.js and is not affected by AUTOPILOT_BROKER_ONLY - that filter is specific to the
// Colmex symbol map and must never reach this universe (its whole point is stocks Colmex doesn't offer).
const store = require("../autopilot/store");
const market = require("../autopilot/market");
const alpaca = require("../providers/alpacaService");

const KIND = "alpacaTrader";
const MAX_UNIVERSE = Number(process.env.ALPACA_TRADER_UNIVERSE_MAX || 400);
const BATCH_SIZE = 50;

function validSymbol(symbol) {
  return typeof symbol === "string" && /^[A-Z]{1,5}$/.test(symbol);
}

function avgDollarVolume20d(bars) {
  const window = (bars || []).filter((bar) => Number(bar?.c) > 0 && Number(bar?.v) >= 0).slice(-20);
  if (window.length < 20) return null;
  return window.reduce((sum, bar) => sum + Number(bar.c) * Number(bar.v), 0) / window.length;
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

async function build(now = Date.now(), profile) {
  const date = market.nyDate(now);
  const assets = await activeAssets();
  const rows = [];
  const diagnostics = { date, sourceAssets: assets.length, belowPrice: 0, belowLiquidity: 0, missing: 0 };
  for (let offset = 0; offset < assets.length; offset += BATCH_SIZE) {
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
      rows.push({ symbol: asset.symbol, close, avgDollarVolume20d: adv20 });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  rows.sort((a, b) => b.avgDollarVolume20d - a.avgDollarVolume20d);
  const capped = rows.slice(0, MAX_UNIVERSE);
  diagnostics.eligible = rows.length;
  diagnostics.capped = Math.max(0, rows.length - capped.length);
  store.put(KIND, "universe", { date, rows: capped, diagnostics, fetchedAt: new Date(now).toISOString() });
  return capped;
}

function getRows(now = Date.now()) {
  const cache = store.get(KIND, "universe");
  return cache?.date === market.nyDate(now) ? cache.rows : [];
}

function status(now = Date.now()) {
  const cache = store.get(KIND, "universe");
  return { ready: Boolean(cache?.rows?.length), date: cache?.date || null, stale: cache?.date !== market.nyDate(now), size: cache?.rows?.length || 0, diagnostics: cache?.diagnostics || null };
}

module.exports = { build, getRows, status };

// READ-ONLY measurement of Alpaca-arm entry fills since the entry price cap (maxSlippagePct) went live.
// Places and changes nothing: opens the database read-only, and only GETs closed orders from the paper account.
// Run on the server (it needs the same environment variables as the app, and the database):
//   node server/scripts/measureAlpacaFills.js [--since 2026-11-13T06:20:00Z] [--db /data/autopilot.sqlite]
// Prints: how many entries were decided / blocked as price_too_far / skipped for other reasons, and for each filled entry the
// planned price, the fill, the gap in % and in R (R = planned price - stop). Output holds no keys or account numbers.
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function readKind(db, kind) {
  return db.prepare("SELECT id, body FROM records WHERE kind = ?").all(kind).map((row) => ({ id: row.id, ...JSON.parse(row.body) }));
}

async function main() {
  const since = Date.parse(arg("--since", "2026-11-13T06:20:00Z"));
  if (!Number.isFinite(since)) throw new Error("--since must be an ISO timestamp");
  const store = require("../src/autopilot/store");
  const dbFile = path.resolve(arg("--db", store.resolveDatabaseFile()));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const log = readKind(db, "alpacaTrader:log").filter((row) => Date.parse(row.at) >= since);
  const meta = readKind(db, "alpacaTrader:tradeMeta").filter((row) => Date.parse(row.at) >= since);
  db.close();

  const reasons = {};
  for (const row of log) reasons[row.reason || row.outcome || "?"] = (reasons[row.reason || row.outcome || "?"] || 0) + 1;
  console.log(`since ${new Date(since).toISOString()}: ${log.length} decisions in the retained log (the log keeps only the latest ~300)`);
  console.log("decisions by reason:", JSON.stringify(reasons));

  const broker = require("../src/alpaca-trader/broker");
  const orders = await broker.getOrders({ status: "closed", limit: 500, after: new Date(since).toISOString(), direction: "asc" });
  const byId = new Map((orders || []).map((o) => [o.id, o]));
  const rows = [];
  for (const m of meta) {
    const order = byId.get(m.orderId);
    const fill = Number(order?.filled_avg_price);
    const planned = Number(m.plannedPrice);
    const stop = Number(m.stop);
    if (!(fill > 0) || !(planned > 0)) continue;
    const gapPct = ((fill - planned) / planned) * 100;
    const riskPct = stop > 0 && planned > stop ? ((planned - stop) / planned) * 100 : null;
    rows.push({ symbol: m.symbol, at: m.at, strategy: m.lead, planned, fill, gapPct, riskPct, gapR: riskPct ? gapPct / riskPct : null });
  }
  console.log(`filled entries with a recorded plan: ${rows.length}`);
  for (const r of rows) {
    console.log(`${r.at.slice(0, 16)} ${r.symbol.padEnd(6)} ${String(r.strategy).padEnd(14)} planned ${r.planned.toFixed(2)} fill ${r.fill.toFixed(2)} gap ${r.gapPct.toFixed(2)}%` + (r.gapR != null ? ` = ${r.gapR.toFixed(2)}R (stop ${r.riskPct.toFixed(2)}%)` : ""));
  }
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const gaps = rows.map((r) => r.gapPct);
  const gapRs = rows.map((r) => r.gapR).filter(Number.isFinite);
  console.log(`average gap: ${avg(gaps) == null ? "n/a" : avg(gaps).toFixed(3) + "%"}; average gap in R: ${avg(gapRs) == null ? "n/a" : avg(gapRs).toFixed(3) + "R"}; max gap: ${gaps.length ? Math.max(...gaps).toFixed(2) + "%" : "n/a"}`);
  const blocked = reasons.price_too_far || 0;
  console.log(`price_too_far: ${blocked}; filled: ${rows.length}; share blocked: ${blocked + rows.length ? ((blocked / (blocked + rows.length)) * 100).toFixed(0) + "%" : "n/a"}`);
}

main().catch((error) => {
  console.error(`measureAlpacaFills failed: ${error.message}`);
  process.exit(1);
});

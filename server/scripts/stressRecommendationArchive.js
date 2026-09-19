const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.env.AUTOPILOT_DB_PATH) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-rec-stress-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "stress.sqlite");
}

const recommendations = require("../src/autopilot/recommendations");
const store = require("../src/autopilot/store");

function signal(index, userId) {
  const published = Date.parse("2026-09-08T14:00:00.000Z") + index * 1000;
  const price = 20 + (index % 80);
  return {
    id: `stress:${index}`,
    ticker: `S${String(index % 500).padStart(3, "0")}`,
    strategy: index % 2 ? "gap_pullback" : "orb15",
    version: "3.1.0",
    entry: price,
    maxEntry: price + 0.2,
    stop: price - 1,
    target: price + 2,
    reason: "stress fixture",
    mode: "day",
    rvol: 2.5,
    gapPct: 3.2,
    daily: { atr14: price * 0.04, price, avgDollarVolume20d: 50_000_000 },
    provenance: { dailyFeed: "sip", intradayFeed: "iex", priceFeed: "iex" },
    createdAt: new Date(published).toISOString(),
    expiresAt: new Date(published + 600000).toISOString(),
    deadline: new Date(published + 3600000).toISOString(),
    status: "active",
    sizing: { feasible: index % 7 !== 0, shares: 1, cost: price, riskUsd: 1 },
  };
}

async function main() {
  const count = Number(process.argv.find((arg) => arg.startsWith("--count="))?.split("=")[1] || 10000);
  const started = Date.now();
  for (let index = 0; index < count; index += 1) {
    const userId = `stress-user-${index % 20}`;
    store.transaction(() => {
      recommendations.archiveSignal({ userId, signal: signal(index, userId), now: Date.parse("2026-09-08T14:00:00.000Z") + index * 1000 });
    });
    if (index % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const page = recommendations.listForUser("stress-user-1", { limit: 100 });
  const summary = recommendations.summaryForUser("stress-user-1");
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    count,
    durationMs: Date.now() - started,
    dbPath: process.env.AUTOPILOT_DB_PATH,
    pageRows: page.rows.length,
    hasNextCursor: Boolean(page.nextCursor),
    summary,
    rssMb: Math.round(memory.rss / 1024 / 1024),
  }, null, 2));
}

main().finally(() => store.close());

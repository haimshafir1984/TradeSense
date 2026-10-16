#!/usr/bin/env node
"use strict";
// TradeSense DEMO end-to-end test helper.
// Creates ONE order intent in an ISOLATED test database, using the real server code
// (risk.validateSignal + bridge.queueSignal), then optionally watches its status.
// It never contacts a broker or MT4 and never touches the real app database or .env.
// The order is only executed if the MT4 EA runs with EnableExecution=true on a DEMO account.
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const realDb = path.resolve(root, "server", "src", "data", "autopilot.sqlite");

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

if (Number(process.versions.node.split(".")[0]) < 22) die(`Node 22+ is required for node:sqlite (found ${process.version}).`);
if (!process.env.AUTOPILOT_DB_PATH) die("AUTOPILOT_DB_PATH is not set. Run this through enqueue-demo-order.cmd so it uses the isolated test database.");
if (path.resolve(process.env.AUTOPILOT_DB_PATH) === realDb) die("Refusing to run against the real app database.");

const symbol = arg("symbol");
const price = Number(arg("price"));
const qty = Number(arg("qty"));
const side = arg("side", "buy");
const pct = Number(arg("pct", "4"));
const digits = Number(arg("digits", "2"));
const brokerAccountId = arg("account", process.env.EXECUTION_BROKER_ACCOUNT_ID);
const watchMinutes = Number(arg("watch", "0"));

if (!symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) die('--symbol is required (no "#": the EA adds its SymbolSuffix), e.g. --symbol Apple');
if (!Number.isFinite(price) || price <= 0) die("--price is required (current market price), e.g. --price 343");
if (!Number.isFinite(qty) || qty <= 0) die("--qty is required (must respect the MT4 min lot / lot step), e.g. --qty 10");
if (!["buy", "sell"].includes(side)) die("--side must be buy or sell");
if (!(pct > 0 && pct < 50)) die("--pct must be between 0 and 50");
if (!brokerAccountId) die("broker account id is missing (--account or EXECUTION_BROKER_ACCOUNT_ID).");

const round = (value) => Number(value.toFixed(digits));
const stop = round(side === "buy" ? price * (1 - pct / 100) : price * (1 + pct / 100));
const target = round(side === "buy" ? price * (1 + pct / 100) : price * (1 - pct / 100));

const orders = require(path.join(root, "server", "src", "execution", "orders"));
const bridge = require(path.join(root, "server", "src", "execution", "bridge"));
const risk = require(path.join(root, "server", "src", "execution", "risk"));

const userId = "demo-e2e-user";
const now = Date.now();
const signal = {
  id: `demo-e2e-${now}`,
  ticker: symbol.toUpperCase(),
  brokerSymbol: symbol,
  side,
  status: "active",
  expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
  entry: price,
  maxEntry: price,
  stop,
  target,
  sizing: { shares: qty },
  strategy: "demo-e2e-test",
  version: "demo-e2e",
};

try {
  risk.validateSignal({ userId, signal, brokerAccountId, symbol, now });
} catch (error) {
  die(`risk check rejected the demo signal: ${error.code || ""} ${error.message}`);
}

const { order, duplicate } = bridge.queueSignal({ userId, signal, brokerAccountId, symbol, now });
console.log(`${duplicate ? "Existing" : "Created"} order ${order.id}`);
console.log(`  ${order.side} ${order.quantity} x ${order.symbol} | stop ${order.stopLoss} | target ${order.takeProfit} | account ${order.brokerAccountId} | status ${order.status}`);
console.log(`  database: ${path.resolve(process.env.AUTOPILOT_DB_PATH)}`);

if (watchMinutes > 0) {
  console.log(`Watching for up to ${watchMinutes} minute(s). Ctrl+C to stop.`);
  const deadline = Date.now() + watchMinutes * 60 * 1000;
  let last = order.status;
  const terminal = new Set(["filled", "rejected", "canceled", "expired"]);
  const timer = setInterval(() => {
    const current = orders.get(order.id);
    if (current && current.status !== last) {
      last = current.status;
      console.log(`[${new Date().toISOString()}] status -> ${current.status}` +
        (current.brokerOrderId ? ` | MT4 ticket ${current.brokerOrderId}` : "") +
        (current.filledQuantity ? ` | filled ${current.filledQuantity}` : "") +
        (current.error ? ` | error: ${current.error}` : ""));
    }
    if ((current && terminal.has(current.status)) || Date.now() > deadline) {
      clearInterval(timer);
      console.log(`Final: ${JSON.stringify(current || order)}`);
      process.exit(0);
    }
  }, 2000);
}

#!/usr/bin/env node
/*
 * Reproducible, local-only v3 backtest entry point. It deliberately does not
 * write to the application database. Explicit --symbols downloads Alpaca data. A data adapter can feed
 * rows produced by the same evaluate() contract; absent that feed the report
 * is explicitly blocked-data rather than a fabricated result.
 */
const fs = require("node:fs");
const path = require("node:path");
if (require.main === module) require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { STRATEGIES } = require("../src/autopilot/strategies");
const alpaca = require("../src/providers/alpacaService");
const market = require("../src/autopilot/market");
const { computeFeaturesFromBars } = require("../src/playbooks/features");
const { evaluate } = require("../src/autopilot/strategies");
const config = require("../src/autopilot/settings");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1]?.startsWith("--") ? true : argv[++i] ?? true;
  }
  return out;
}
function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
function dateOnly(value) { return market.nyDate(Date.parse(value)); }
function metrics(trades) {
  const pnl = trades.map((row) => row.pnl);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return { trades: trades.length, winRate: trades.length ? wins.length / trades.length : null, netPnl: pnl.reduce((sum, value) => sum + value, 0), profitFactor: grossLoss ? grossWin / grossLoss : null };
}
function resolveExit(bars, entryAt, deadline, plan) {
  // Only post-fill bars; the entry fill is at the opening of entryAt.
  const eligible = bars.filter(bar => Date.parse(bar.t) >= entryAt &&
    Date.parse(bar.t) + 300000 <= deadline);
  for (const bar of eligible) {
    if (bar.l <= plan.stop) return { price: Math.min(bar.o, plan.stop), reason: "stop" };
    if (bar.h >= plan.target) return { price: plan.target, reason: "target" };
  }
  const last = eligible.at(-1);
  return last && Date.parse(last.t) + 300000 === deadline
    ? { price: last.c, reason: "deadline" } : null;
}
async function runInitialProbe(options, selected) {
  const symbols = String(options.symbols).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const from = options.from || "2026-08-01T00:00:00Z";
  const to = options.to || new Date().toISOString();
  const now = Date.now();
  const daily = await alpaca.getBarsDetailed({ symbols, timeframe: "1Day", start: from, end: to, feed: "sip", now });
  const intradayFrom = options.intradayFrom || from;
  const intradayTo = options.intradayTo || to;
  const intraday = await alpaca.getBarsDetailed({ symbols, timeframe: "5Min", start: intradayFrom, end: intradayTo, feed: "iex", now });
  const trades = [];
  const calendar = await alpaca.getCalendar(String(from).slice(0, 10), String(to).slice(0, 10));
  if (!Array.isArray(calendar)) throw new Error("Calendar unavailable");
  const signalCounts = Object.fromEntries(selected.map((key) => [key, 0]));
  let sessionCount = 0;
  for (const symbol of symbols) {
    const dailyBars = daily.bars.get(symbol) || [];
    const intradayBars = intraday.bars.get(symbol) || [];
    const sessions = [...new Set(dailyBars.map((bar) => dateOnly(bar.t)))];
    sessionCount += sessions.length;
    for (let index = 200; index < sessions.length; index += 1) {
      const sessionDate = sessions[index];
      const prior = dailyBars.filter((bar) => dateOnly(bar.t) < sessionDate);
      const features = computeFeaturesFromBars(prior);
      const session = intradayBars.filter((bar) => dateOnly(bar.t) === sessionDate);
      if (session.length < 3) continue;
      const calendarIndex = calendar.findIndex(item => item.date === sessionDate);
      const currentSession = calendar[calendarIndex], finalSession = calendar[calendarIndex + 4];
      if (!currentSession || !finalSession) continue;
      const open = market.nyTimestamp(sessionDate, currentSession.open.slice(0, 5));
      const close = market.nyTimestamp(sessionDate, currentSession.close.slice(0, 5));
      const deadline = market.nyTimestamp(finalSession.date, finalSession.close.slice(0, 5)) - 300000;
      let openedThisSession = false;
      for (let barIndex = 1; barIndex < session.length - 1; barIndex += 1) {
        if (openedThisSession) break;
        const asOf = Date.parse(session[barIndex].t) + 300000;
        const plans = evaluate({ daily: features, bars: session, asOf, sessionOpen: open, sessionClose: close, rvol: null });
        for (const plan of plans.filter((item) => selected.includes(item.strategy))) {
          signalCounts[plan.strategy] += 1;
          const next = session[barIndex + 1];
          const entry = next.o;
          if (!(entry >= plan.entry && entry <= plan.maxEntry)) continue;
          const outcome = resolveExit(intradayBars, Date.parse(next.t), deadline, plan);
          if (!outcome) continue;
          const exit = outcome.price, reason = outcome.reason;
          const feeMode = options.fees === "free" ? "free" : "paid";
          const entryFee = config.fee(1, entry, feeMode);
          const exitFee = config.fee(1, exit, feeMode);
          trades.push({ symbol, strategy: plan.strategy, sessionDate, entry, exit, reason, pnl: exit - entry - entryFee - exitFee });
          openedThisSession = true;
          break;
        }
      }
    }
  }
  return { status: "initial-sample", method: "same evaluate() contract; next-5-minute open entry; post-entry IEX 5-minute OHLC exit model", ranges: { requested: { from, to, intradayFrom, intradayTo }, development: "not covered", validation: "not covered", holdout: "not covered" }, feeds: { daily: "SIP", intraday: "IEX", quotes: "not supplied; OHLC approximation" }, coverage: { symbols: symbols.length, sessions: sessionCount, dailyBars: [...daily.bars.values()].reduce((sum, rows) => sum + rows.length, 0), intradayBars: [...intraday.bars.values()].reduce((sum, rows) => sum + rows.length, 0) }, provider: { dailyComplete: daily.complete, intradayComplete: intraday.complete, dailyFailed: daily.failedSymbols, intradayFailed: intraday.failedSymbols, errors: [...daily.errors, ...intraday.errors] }, signalCounts, metrics: metrics(trades), trades, limitations: ["single requested symbol set", "limited date window", "no survivorship-free historical universe", "no historical quote/spread freshness", "IEX 5-minute OHLC used for exits; unresolved exits omitted", "not a profitability validation"], evidence: "experimental" };
}
async function main() {
  const options = args(process.argv.slice(2));
  const selected = String(options.strategies || "pullback2_v1,breakout20_v1").split(",").filter(Boolean);
  const known = new Set(STRATEGIES.map((s) => s.key));
  const unknown = selected.filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown strategies: ${unknown.join(", ")}`);
  if (options.symbols) {
    const report = await runInitialProbe(options, selected);
    report.commit = options.commit || "working-tree";
    report.strategyVersion = Object.fromEntries(selected.map((key) => [key, STRATEGIES.find((s) => s.key === key).version]));
    const out = options.output ? path.resolve(options.output) : null;
    if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, json(report)); fs.writeFileSync(out.replace(/\.json$/i, ".md"), `# v3 initial sample\n\nStatus: **${report.status}**\n\nThis is not a profitability validation.\n`); fs.writeFileSync(out.replace(/\.json$/i, ".csv"), ["symbol,strategy,sessionDate,entry,exit,reason,pnl", ...report.trades.map((row) => [row.symbol,row.strategy,row.sessionDate,row.entry,row.exit,row.reason,row.pnl].join(","))].join("\n") + "\n"); }
    process.stdout.write(json(report));
    return;
  }
  const report = {
    status: "blocked-data",
    reason: "No historical feed was supplied. This CLI never downloads or invents data.",
    commit: options.commit || "working-tree",
    strategyVersion: Object.fromEntries(selected.map((key) => [key, STRATEGIES.find((s) => s.key === key).version])),
    parametersHash: "not-computed-without-feed",
    ranges: { development: "2020-01-01/2023-12-31", validation: "2024-01-01/2024-12-31", holdout: "2025-01-01/2025-12-31", extra2026: "2026-01-01/2026-09-11" },
    requested: { from: options.from || null, to: options.to || null, symbols: options.symbols || null, equity: options.equity || "100,500,1000", fees: options.fees || "paid,free", slippage: "0.1%,0.2%", latency: "0,1 bar" },
    feeds: { daily: "SIP", intraday: "IEX", quotes: "not supplied" },
    coverage: { symbols: 0, sessions: 0, trades: 0 },
    missing: ["historical SIP/IEX feed", "published quote/spread history", "survivorship-free universe"],
    survivorshipBias: null,
    strategies: Object.fromEntries(selected.map((key) => [key, { status: "experimental", trades: 0, metrics: null, thresholdPassed: false }])),
  };
  if (options.input) {
    const inputPath = path.resolve(options.input);
    if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
    report.input = inputPath;
    report.reason = "Input was found, but this first adapter only validates the contract; no trade rows were supplied for measurement.";
  };
  const out = options.output ? path.resolve(options.output) : null;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json(report));
    fs.writeFileSync(out.replace(/\.json$/i, ".md"), `# v3 backtest\n\nStatus: **${report.status}**\n\n${report.reason}\n\nNo profitability claim is made.\n`);
  }
  process.stdout.write(json(report));
}
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { resolveExit };

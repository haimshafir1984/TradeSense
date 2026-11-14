// One scan cycle for the Alpaca arm: build/refresh the universe, fetch daily + intraday bars (the
// same shared, symbol-keyed caches the Colmex side uses - autopilot/history.js - read-only reuse,
// no shared decision state), evaluate every active strategy per symbol, and feed matches into entry.js.
//
// Known v1 simplification: relative volume is a simple same-session proxy (today's cumulative IEX volume
// vs. the stock's own 20-day IEX average volume from universe.js, scaled by elapsed time), not the
// calendar-exact version the main engine uses. Trading hours come from session.js (Alpaca's calendar: holidays and shortened days).
const { nyTimestamp } = require("../autopilot/market");
const calendar = require("./session");
const history = require("../autopilot/history");
const strategies = require("../autopilot/strategies");
const universe = require("./universe");
const entry = require("./entry");
const shadow = require("./shadow");

const INTRADAY_BATCH = 20;

function isMarketHours(now) {
  return calendar.inSession(now);
}

function sessionBounds(now) {
  const s = calendar.sessionFor(now);
  return { open: s.open ?? nyTimestamp(s.date, "09:30"), close: s.close ?? nyTimestamp(s.date, "16:00") };
}

function simpleRvol(bars, session, now, avgVolume20d) {
  if (!Number.isFinite(avgVolume20d) || avgVolume20d <= 0) return null;
  const closedBars = (bars || []).filter((bar) => Date.parse(bar.t) >= session.open && Date.parse(bar.t) + 300000 <= now);
  if (!closedBars.length) return null;
  const elapsedMs = Math.min(now - session.open, session.close - session.open);
  if (elapsedMs < 900000) return null;
  const soFar = closedBars.reduce((sum, bar) => sum + Number(bar.v || 0), 0);
  const expected = avgVolume20d * (elapsedMs / (session.close - session.open));
  return expected > 0 ? soFar / expected : null;
}

async function run(profile, now = Date.now()) {
  const diagnostics = { marketOpen: isMarketHours(now), universeSize: 0, evaluated: 0, matched: 0, rvolMissing: 0, rvolMax: 0, rvolOver1_2: 0, reasons: {}, errors: [] };
  if (!diagnostics.marketOpen) return diagnostics;

  let rows = universe.getRows(now);
  if (!rows.length) {
    try {
      rows = await universe.build(now, profile);
    } catch (error) {
      diagnostics.errors.push({ stage: "universe", message: error.message });
      return diagnostics;
    }
  }
  diagnostics.universeSize = rows.length;
  if (!rows.length) return diagnostics;

  const symbols = rows.map((r) => r.symbol);
  const fundLike = new Set(rows.filter((r) => r.fundLike).map((r) => r.symbol));
  const iexAvgVolume = new Map(rows.map((r) => [r.symbol, r.avgIexVolume20d]));
  const dailyResult = await history.ensureDailyFeatures(symbols, now);
  const session = sessionBounds(now);
  // Strategies read only just-closed 5-minute candles and reject data whose newest closed candle is over 7 minutes old
  // (strategies.js). Judged against the raw clock, a scan that starts 2+ minutes into a bar window (a startup scan, one
  // delayed by a long previous scan) saw every stock as intraday_missing (2026-11-12: 896/896). Evaluate as of the
  // latest 5-minute boundary instead: same candles, and the timing of the scan inside the window no longer matters.
  const barBoundary = Math.floor(now / 300000) * 300000;

  for (let offset = 0; offset < symbols.length; offset += INTRADAY_BATCH) {
    if (universe.overMemoryGuard()) {
      diagnostics.errors.push({ stage: "intraday", message: `stopped at ${offset}/${symbols.length}: memory guard` });
      break;
    }
    const batch = symbols.slice(offset, offset + INTRADAY_BATCH);
    // Only today's session is needed (evaluateDetailed ignores earlier candles), so ask for just that.
    // Without an explicit start, a symbol never cached before triggers a full 26-day backfill
    // (history.js INTRADAY_WINDOW_MS) - harmless for the main engine's warm cache, but this engine's
    // brand-new universe hit it all at once and was OOM-killed mid-scan (exit 137, 2026-11-03).
    const intraday = await history.ensureIntradayBars(batch, {
      now,
      feed: "iex",
      start: new Date(session.open).toISOString(),
      evict: offset + INTRADAY_BATCH >= symbols.length,
    });
    diagnostics.errors.push(...(intraday.errors || []));
    for (const symbol of batch) {
      const daily = dailyResult.features.get(symbol)?.features;
      const bars = intraday.bars.get(symbol) || [];
      if (!daily || !bars.length) continue;
      diagnostics.evaluated += 1;
      const rvol = simpleRvol(bars, session, now, iexAvgVolume.get(symbol));
      if (rvol == null) diagnostics.rvolMissing += 1;
      else {
        diagnostics.rvolMax = Math.max(diagnostics.rvolMax, Number(rvol.toFixed(2)));
        if (rvol >= 1.2) diagnostics.rvolOver1_2 += 1;
      }
      const { plans, results } = strategies.evaluateDetailed({
        bars, asOf: barBoundary, sessionOpen: session.open, sessionClose: session.close,
        daily, rvol, gapPct: daily.gapPct, hasNews: null,
      });
      // Shadow labelling: every signal is followed on the candles (bought or not), and open ones are updated with the new candles.
      try {
        for (const plan of plans) shadow.recordSignal({ plan, symbol, daily, rvol, session, now: barBoundary, fundLike: fundLike.has(symbol) });
        shadow.update(symbol, bars, now);
      } catch {
        // learning data only: never let it affect the scan
      }
      // Why each enabled strategy did or did not match, summed over the universe (shows up in /status diagnostics).
      for (const [strategy, result] of results || []) {
        if (!profile.strategies.includes(strategy)) continue;
        const code = result.matched ? "matched" : result.reasonCode || "unknown";
        const bucket = (diagnostics.reasons[strategy] ||= {});
        bucket[code] = (bucket[code] || 0) + 1;
      }
      for (const plan of plans) {
        if (!profile.strategies.includes(plan.strategy)) continue;
        if (fundLike.has(symbol)) { diagnostics.fundSkipped = (diagnostics.fundSkipped || 0) + 1; continue; } // labelled in the shadow, never traded
        diagnostics.matched += 1;
        entry.observe({
          now,
          signal: {
            id: `${symbol}:${plan.strategy}:${plan.barAt}`,
            ticker: symbol,
            strategy: plan.strategy,
            entry: plan.entry,
            maxEntry: plan.maxEntry,
            stop: plan.stop,
            target: plan.target,
            rvol,
            daily,
            expiresAt: new Date(now + 10 * 60000).toISOString(),
          },
        });
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return diagnostics;
}

module.exports = { run, isMarketHours, sessionBounds, simpleRvol };

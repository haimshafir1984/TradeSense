const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-v3-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.PORTFOLIO_STORE_FILE_PATH = path.join(scratch, "portfolio.json");
const store = require("../src/autopilot/store");
const config = require("../src/autopilot/settings");
const market = require("../src/autopilot/market");
const strategy = require("../src/autopilot/strategies");
const selection = require("../src/autopilot/selection");
const tracking = require("../src/autopilot/tracking");
const autopilotHistory = require("../src/autopilot/history");
const autopilotUniverse = require("../src/autopilot/universe");
const alpaca = require("../src/providers/alpacaService");
const notices = require("../src/autopilot/notifications");
const users = require("../src/autopilot/users");
const recommendations = require("../src/autopilot/recommendations");
const recommendationEvaluator = require("../src/autopilot/recommendationEvaluator");
const feedback = require("../src/autopilot/feedback");
const USER = "unit-user";
test.after(() => {
  store.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const start = Date.parse("2026-09-08T13:30:00Z");
const iso = (t) => new Date(t).toISOString();
const bar = (i, extras = {}) => ({
  t: iso(start + i * 300000),
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 100,
  vw: 100,
  ...extras,
});
const signal = (id) => ({
  id,
  ticker: "TEST",
  strategy: "orb15",
  version: "3.0.0",
  entry: 100,
  maxEntry: 101,
  stop: 98,
  target: 104,
  createdAt: iso(start),
  expiresAt: iso(start + 600000),
  deadline: iso(start + 3600000),
  mode: "day",
  sizing: { feasible: true },
});

test("broker-neutral sizing does not apply broker fees", () => {
  assert.equal(config.fee(0.7, 100), 0);
  assert.equal(config.fee(1, 100), 0);
  assert.equal(config.fee(200, 100), 0);
});
test("sizing respects cash plus entry fee and total stop risk", () => {
  const s = { ...config.DEFAULTS, equity: 100, availableCash: 100 };
  const size = config.size(signal("size"), s);
  assert.ok(size.cost <= 30);
  assert.ok(size.riskUsd <= 0.5);
  assert.equal(
    config.size(signal("size"), { ...s, fractional: false }).feasible,
    false,
  );
  assert.ok(config.size(signal("size"), s, 99.9).cost <= 0.1);
  assert.equal(
    config.size({ ...signal("size"), target: 100.01 }, s).feasible,
    false,
  );
});
test("invalid settings cannot enable unsupported strategies or excessive risk", () => {
  assert.throws(() => config.save({ riskPct: 20 }, USER));
  assert.throws(() => config.save({ enabled: "yes" }, USER));
  assert.throws(() => config.save({ strategies: ["madeup"] }, USER));
});
test("first login creates a separate profile even with a simple code", () => {
  const first = users.session({ code: "1234" });
  const second = users.session({ code: "1234" });
  assert.notEqual(first.userId, second.userId);
  assert.equal(users.session({ userId: first.userId, code: "1234" }).userId, first.userId);
  assert.throws(() => users.session({ userId: first.userId, code: "4321" }));
});
test("market timestamps follow New York DST, and stale prices fail closed", () => {
  assert.equal(
    iso(market.nyTimestamp("2026-01-05", "09:30")),
    "2026-01-05T14:30:00.000Z",
  );
  assert.equal(
    iso(market.nyTimestamp("2026-09-08", "09:30")),
    "2026-09-08T13:30:00.000Z",
  );
  assert.equal(market.freshPrice({ dailyBar: { c: 100 } }, start), null);
  assert.equal(
    market.freshPrice(
      { latestTrade: { p: 100, t: iso(start - 91000) } },
      start,
    ),
    null,
  );
  assert.equal(
    market.freshPrice({ latestTrade: { p: 100, t: iso(start + 5000) } }, start),
    null,
  );
  assert.equal(
    market.freshPrice({ latestTrade: { p: 100, t: iso(start) } }, start).price,
    100,
  );
});
test("opening breakout uses closed bars only and requires complete opening range", () => {
  const bars = [bar(0), bar(1), bar(2), bar(3, { c: 102, h: 103 })];
  const args = {
    daily: { atr14: 2 },
    bars,
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
  };
  assert.equal(strategy.evaluate(args)[0].strategy, "orb15");
  assert.deepEqual(strategy.evaluate({ ...args, asOf: start + 1199999 }), []);
  assert.deepEqual(strategy.evaluate({ ...args, bars: bars.slice(1) }), []);
  assert.deepEqual(strategy.evaluate({ ...args, rvol: null }), []);
  assert.equal(strategy.vwap([{ v: 100, c: 100 }]), null);
});
test("new day strategy variants require confirmation instead of chasing the first move", () => {
  const daily = { price: 100, atr14: 2 };
  const sessionClose = start + 23400000;
  const orbBars = [
    bar(0, { o: 100, h: 101, l: 99, c: 100 }),
    bar(1, { o: 100, h: 101.2, l: 99.5, c: 100.5 }),
    bar(2, { o: 100.5, h: 101.5, l: 100, c: 101 }),
    bar(3, { o: 101.2, h: 102.5, l: 101, c: 102.1 }),
    bar(4, { o: 101.4, h: 102.2, l: 101.45, c: 102 }),
  ];
  const orbPlans = strategy.evaluate({
    daily,
    bars: orbBars,
    asOf: start + 1500000,
    sessionOpen: start,
    sessionClose,
    rvol: 2,
  });
  assert.ok(orbPlans.some((plan) => plan.strategy === "orb15_retest"));

  const vwapBars = [
    bar(0, { o: 100, h: 101, l: 99.8, c: 100.5, v: 100, vw: 100.2 }),
    bar(1, { o: 100.5, h: 102, l: 100.4, c: 101.8, v: 120, vw: 101 }),
    bar(2, { o: 101.8, h: 102.5, l: 101.2, c: 102, v: 120, vw: 101.8 }),
    bar(3, { o: 102, h: 102.2, l: 100.9, c: 101.4, v: 80, vw: 101.2 }),
    bar(4, { o: 101.3, h: 102.4, l: 101.05, c: 102.3, v: 110, vw: 101.5 }),
    bar(5, { o: 101.5, h: 103, l: 101.35, c: 102.8, v: 140, vw: 102.4 }),
  ];
  const vwapPlans = strategy.evaluate({
    daily,
    bars: vwapBars,
    asOf: start + 1800000,
    sessionOpen: start,
    sessionClose,
    rvol: 1.6,
  });
  assert.ok(vwapPlans.some((plan) => plan.strategy === "vwap_pullback"));

  const flagBars = [
    bar(0, { o: 104, h: 104.5, l: 103.5, c: 104.2, v: 200 }),
    bar(1, { o: 104.2, h: 106, l: 104, c: 105.6, v: 400 }),
    bar(2, { o: 105.6, h: 107, l: 105.5, c: 106.8, v: 500 }),
    bar(3, { o: 106.8, h: 107, l: 106, c: 106.4, v: 250 }),
    bar(4, { o: 106.4, h: 106.6, l: 105.9, c: 106.2, v: 220 }),
    bar(5, { o: 106.2, h: 108, l: 106.1, c: 107.5, v: 450 }),
  ];
  const flagPlans = strategy.evaluate({
    daily,
    bars: flagBars,
    asOf: start + 1800000,
    sessionOpen: start,
    sessionClose,
    rvol: 2.5,
    gapPct: 4,
    hasNews: true,
  });
  assert.ok(flagPlans.some((plan) => plan.strategy === "momentum_bull_flag"));
  const waitingForNews = strategy.evaluateDetailed({
    daily,
    bars: flagBars,
    asOf: start + 1800000,
    sessionOpen: start,
    sessionClose,
    rvol: 2.5,
    gapPct: 4,
    hasNews: null,
  });
  assert.equal(waitingForNews.results.get("momentum_bull_flag").reasonCode, "news_needed");
});
test("day strategies can be diagnosed with ATR even when MA200 is unavailable", () => {
  const bars = [bar(0), bar(1), bar(2), bar(3, { c: 100.5, h: 101 })];
  const detailed = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2, ma200: null },
    bars,
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 1.1,
    gapPct: null,
    hasNews: null,
  });
  assert.equal(detailed.results.get("orb15").reasonCode, "rvol_below_threshold");
  assert.equal(detailed.results.get("reversal5").reasonCode, "daily_missing");
});
test("gap pullback asks for news only after the price trigger is otherwise ready", () => {
  const notTriggered = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2 },
    bars: [bar(0), bar(1), bar(2), bar(3, { c: 101, h: 102 })],
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
    gapPct: 4,
    hasNews: null,
  });
  assert.equal(notTriggered.results.get("gap_pullback").reasonCode, "trigger_not_met");

  const readyForNews = strategy.evaluateDetailed({
    daily: { price: 100, atr14: 2 },
    bars: [
      bar(0, { o: 103, c: 104, h: 104, l: 102 }),
      bar(1, { o: 104, c: 105, h: 105, l: 103 }),
      bar(2, { o: 105, c: 104, h: 106, l: 103 }),
      bar(3, { o: 104, c: 107, h: 108, l: 104 }),
    ],
    asOf: start + 1200000,
    sessionOpen: start,
    sessionClose: start + 23400000,
    rvol: 2,
    gapPct: 4,
    hasNews: null,
  });
  assert.equal(readyForNews.results.get("gap_pullback").reasonCode, "news_needed");
});
test("selection uses strategy lists, dedupes symbols, and rotates beyond the top activity names", () => {
  store.remove("runtime", "selection-cursor");
  const now = start + 1200000;
  const today = { date: market.nyDate(now), open: start, close: start + 23400000 };
  const rows = Array.from({ length: 30 }, (_, index) => ({
    symbol: `S${index}`,
    companyName: `Symbol ${index}`,
    exchange: "NASDAQ",
    close: index === 29 ? 10 : 100,
    avgDollarVolume20d: 2_000_000 + index,
  }));
  const snapshots = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        dailyBar: {
          t: iso(now),
          o: index === 29 ? 10.5 : 100,
          c: index === 29 ? 10.8 : 101 + index,
          v: 1000 + index,
        },
        latestTrade: { p: index === 29 ? 10.8 : 101 + index, t: iso(now) },
      },
    ]),
  );
  const dailyFeatures = new Map(
    rows.map((row) => [row.symbol, { features: { price: row.close, atr14: 2 } }]),
  );
  const picked = selection.selectCandidates({
    rows,
    snapshots,
    dailyFeatures,
    activeStrategies: ["orb15", "gap_pullback"],
    calendar: [today],
    today,
    now,
  });
  assert.ok(picked.selected.length <= 120);
  assert.ok(picked.selected.some((item) => item.symbol === "S29"));
  assert.ok(picked.diagnostics.listSizes.gap_pullback >= 1);
});
test("VWAP selection ranks cached comparable IEX volume before plain activity", () => {
  store.remove("runtime", "selection-cursor");
  const now = start + 1200000;
  const today = { date: market.nyDate(now), open: start, close: start + 23400000 };
  const calendar = Array.from({ length: 6 }, (_, i) => ({
    date: market.nyDate(start - (5 - i) * 86400000),
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const rows = [
    { symbol: "LOWRV", companyName: "Low RVOL", exchange: "NASDAQ", close: 100 },
    { symbol: "HIGHRV", companyName: "High RVOL", exchange: "NASDAQ", close: 100 },
  ];
  const snapshots = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        dailyBar: { t: iso(now), o: 100, c: 101, v: index === 0 ? 5000 : 1000 },
        latestTrade: { p: 101, t: iso(now) },
      },
    ]),
  );
  const dailyFeatures = new Map(rows.map((row) => [row.symbol, { features: { price: row.close, atr14: 2 } }]));
  const historyBars = (todayVolume) =>
    calendar.flatMap((session, index) =>
      Array.from({ length: 4 }, (_, k) => ({
        ...bar(k),
        t: iso(session.open + k * 300000),
        v: index === 5 ? todayVolume : 100,
      })),
    );
  const intradayCache = new Map([
    ["LOWRV", historyBars(110)],
    ["HIGHRV", historyBars(300)],
  ]);

  const picked = selection.selectCandidates({
    rows,
    snapshots,
    dailyFeatures,
    intradayCache,
    activeStrategies: ["vwap_reclaim"],
    calendar,
    today,
    now,
  });

  assert.equal(picked.lists.vwap_reclaim[0].symbol, "HIGHRV");
  assert.equal(picked.selected[0].symbol, "HIGHRV");
});
test("relative volume compares matching elapsed time and ignores future volume", () => {
  const days = Array.from({ length: 6 }, (_, i) => ({
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const bars = days.flatMap((s, i) =>
    Array.from({ length: 4 }, (_, k) => ({
      ...bar(k),
      t: iso(s.open + k * 300000),
      v: i === 5 ? 200 : 100,
    })),
  );
  bars.push({ ...bar(5), v: 100000 });
  assert.equal(market.openingRvol(bars, days, days[5], start + 1200000), 2);
  assert.equal(
    market.openingRvol(bars.slice(1), days, days[5], start + 1200000),
    null,
  );
});
test("partial daily history does not cache failed symbols as usable features", async (t) => {
  const symbol = "PART";
  const now = start + 1200000;
  store.remove("history", autopilotHistory.cacheKey({ symbol, feed: "sip", timeframe: "1Day" }));
  t.mock.method(alpaca, "getBarsDetailed", async () => ({
    bars: new Map([
      [
        symbol,
        Array.from({ length: 20 }, (_, index) => ({
          t: iso(start - (20 - index) * 86400000),
          o: 10,
          h: 11,
          l: 9,
          c: 10,
          v: 1000,
        })),
      ],
    ]),
    complete: false,
    failedSymbols: [symbol],
    errors: [{ status: 429, kind: "rate_limit" }],
  }));

  const result = await autopilotHistory.ensureDailyFeatures([symbol], now);

  assert.equal(result.complete, false);
  assert.equal(result.features.has(symbol), false);
  assert.equal(store.get("history", autopilotHistory.cacheKey({ symbol, feed: "sip", timeframe: "1Day" })), null);
});
test("universe build processes market history in bounded batches without changing eligibility", async (t) => {
  const now = Date.parse("2026-09-10T16:00:00Z");
  const symbols = Array.from({ length: 151 }, (_, index) => {
    const first = String.fromCharCode(65 + Math.floor(index / 26));
    const second = String.fromCharCode(65 + (index % 26));
    return `${first}${second}`;
  });
  const requestedBatches = [];
  store.remove("cache", "v3-universe");
  t.mock.method(alpaca, "getActiveAssets", async ({ exchange }) =>
    symbols
      .filter((_, index) => (exchange === "NASDAQ" ? index % 2 === 0 : index % 2 === 1))
      .map((symbol) => ({ symbol, name: symbol, exchange })),
  );
  t.mock.method(alpaca, "getBarsDetailed", async ({ symbols: batch }) => {
    requestedBatches.push([...batch]);
    return {
      bars: new Map(
        batch.map((symbol) => [
          symbol,
          Array.from({ length: 20 }, (_, index) => ({
            t: iso(now - (21 - index) * 86400000),
            o: 10,
            h: 11,
            l: 9,
            c: 10,
            v: 300000,
          })),
        ]),
      ),
      complete: true,
      failedSymbols: [],
      errors: [],
    };
  });

  const rows = await autopilotUniverse.ensure(now);

  assert.equal(rows.length, symbols.length);
  assert.ok(requestedBatches.length > 1);
  assert.ok(requestedBatches.every((batch) => batch.length <= 75));
  assert.deepEqual(
    new Set(requestedBatches.flat()),
    new Set(symbols),
  );
});
test("intraday history refreshes fully on a new session and does not mix old split-adjusted bars", async (t) => {
  const symbol = "SPLT";
  const previousDay = Date.parse("2026-09-08T15:00:00Z");
  const nextDay = Date.parse("2026-09-09T15:00:00Z");
  const key = autopilotHistory.cacheKey({ symbol, feed: "iex", timeframe: "5Min" });
  store.put("history", key, {
    symbol,
    feed: "iex",
    timeframe: "5Min",
    adjustment: "split",
    schema: "v1",
    bars: [{ ...bar(0), t: iso(previousDay), c: 200 }],
    watermarkAt: iso(previousDay + 300000),
    lastBarAt: iso(previousDay),
    fetchedAt: iso(previousDay),
    lastUsedAt: iso(previousDay),
    sessionDate: market.nyDate(previousDay),
  });
  let capturedStart = null;
  t.mock.method(alpaca, "getBarsDetailed", async ({ start }) => {
    capturedStart = start;
    return {
      bars: new Map([[symbol, [{ ...bar(0), t: iso(nextDay), c: 100 }]]]),
      complete: true,
      failedSymbols: [],
      errors: [],
    };
  });

  const result = await autopilotHistory.ensureIntradayBars([symbol], { now: nextDay, keepSymbols: [] });

  assert.ok(Date.parse(capturedStart) <= nextDay - 26 * 86400000 + 1000);
  assert.deepEqual(result.bars.get(symbol).map((item) => item.c), [100]);
  assert.equal(store.get("history", key).sessionDate, market.nyDate(nextDay));
});
test("persisted lease and transaction survive reopen without duplicate run", () => {
  assert.equal(store.lease("test", 1000, start), true);
  store.close();
  assert.equal(store.lease("test", 1000, start + 100), false);
  assert.throws(() =>
    store.transaction(() => {
      store.put("rollback", "x", { a: 1 });
      throw Error("rollback");
    }),
  );
  assert.equal(store.get("rollback", "x"), null);
});
test("recommendation archive stores a published signal even when no trade is reported", () => {
  const s = {
    ...signal("archive"),
    rvol: 2.4,
    gapPct: 3.2,
    daily: { atr14: 3.5, price: 100, avgDollarVolume20d: 30_000_000 },
    provenance: { intradayFeed: "iex", dailyFeed: "sip" },
  };
  store.transaction(() => recommendations.archiveSignal({ userId: USER, signal: s, now: start + 1000 }));
  const page = recommendations.listForUser(USER, { limit: 10 });
  const row = page.rows.find((item) => item.plan.sourceSignalId === "archive");
  assert.ok(row);
  assert.equal(row.tags.fast_momentum_candidate, true);
  assert.equal(recommendations.summaryForUser(USER).published >= 1, true);
  assert.equal(store.getUser(USER, "trade", "sim:archive"), null);
});
test("recommendation archive keeps separate user receipts for the same setup", () => {
  const s = signal("shared-setup");
  store.transaction(() => recommendations.archiveSignal({ userId: "archive-a", signal: s, now: start + 2000 }));
  store.transaction(() => recommendations.archiveSignal({ userId: "archive-b", signal: s, now: start + 2000 }));
  assert.equal(recommendations.listForUser("archive-a", { limit: 10 }).rows.length, 1);
  assert.equal(recommendations.listForUser("archive-b", { limit: 10 }).rows.length, 1);
  assert.notEqual(
    recommendations.listForUser("archive-a", { limit: 10 }).rows[0].id,
    recommendations.listForUser("archive-b", { limit: 10 }).rows[0].id,
  );
});
test("recommendation evaluator requires an observable post-publication entry bar", () => {
  const rec = {
    publishedAt: iso(start + 120000),
    plan: signal("eval"),
    provenance: { intradayFeed: "iex" },
  };
  const noFill = recommendationEvaluator.evaluateRecommendation({
    recommendation: rec,
    bars: Array.from({ length: 12 }, (_, index) =>
      index === 0 ? bar(index, { o: 100, h: 105, l: 95 }) : bar(index, { o: 99, h: 103, l: 98.5 }),
    ),
  });
  assert.equal(noFill.outcomeStatus, "no_observed_fill");
  const target = recommendationEvaluator.evaluateRecommendation({
    recommendation: { ...rec, publishedAt: iso(start) },
    bars: Array.from({ length: 12 }, (_, index) =>
      index === 1 ? bar(index, { o: 100.5, h: 104.5, l: 100 }) : bar(index, { o: 99, h: 103, l: 98.5 }),
    ),
  });
  assert.equal(target.outcomeStatus, "target");
  assert.equal(target.metrics.entry, 100.5);
});
test("recommendation evaluator refuses incomplete coverage and deadline lookahead", () => {
  const rec = {
    publishedAt: iso(start),
    plan: signal("coverage"),
    provenance: { intradayFeed: "iex" },
  };
  const missingDeadline = recommendationEvaluator.evaluateRecommendation({
    recommendation: rec,
    bars: [bar(0, { o: 100, h: 102, l: 99, c: 101 })],
  });
  assert.equal(missingDeadline.workflowStatus, "retryable_error");
  assert.equal(missingDeadline.outcomeStatus, "unresolved");
  const afterDeadline = recommendationEvaluator.evaluateRecommendation({
    recommendation: rec,
    bars: [
      ...Array.from({ length: 12 }, (_, index) => bar(index, { o: 100, h: 102, l: 99, c: 101 })),
      bar(12, { o: 101, h: 112, l: 100, c: 111 }),
    ],
  });
  assert.equal(afterDeadline.outcomeStatus, "time_exit");
  assert.notEqual(afterDeadline.outcomeStatus, "target");
});
test("recommendation evaluator marks pre-entry invalidation conservatively", () => {
  const rec = {
    publishedAt: iso(start),
    plan: signal("invalidated"),
    provenance: { intradayFeed: "iex" },
  };
  const result = recommendationEvaluator.evaluateRecommendation({
    recommendation: rec,
    bars: Array.from({ length: 12 }, (_, index) =>
      index === 0
        ? bar(index, { o: 102, h: 103, l: 97, c: 99 })
        : bar(index, { o: 100, h: 105, l: 99, c: 104 }),
    ),
  });
  assert.equal(result.outcomeStatus, "invalidated_before_entry");
});
test("recommendation evaluator records SIP horizon movement and quote opportunity separately from actual fills", () => {
  const rec = {
    publishedAt: iso(start),
    plan: signal("sip-horizon"),
    provenance: { intradayFeed: "sip" },
  };
  const oneMinuteBars = Array.from({ length: 4 }, (_, index) => ({
    t: iso(start + index * 60000),
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100.5 + index,
    v: 1000,
  }));
  const movement = recommendationEvaluator.horizonMovement({
    recommendation: rec,
    bars: oneMinuteBars,
    horizon: "d0",
    timeframe: "1Min",
  });
  assert.equal(movement.outcomeStatus, "movement_observed");
  assert.equal(movement.metrics.returnFromPlanEntryPct > 0, true);

  const quote = recommendationEvaluator.quoteOpportunity({
    quotes: [{ t: iso(start + 5000), bidPrice: 99.98, askPrice: 100.02 }],
    plan: rec.plan,
    publishedAt: rec.publishedAt,
  });
  assert.equal(quote.observed, true);
  assert.equal(Number.isFinite(quote.spreadBps), true);
});
test("quote opportunity does not treat late quotes as timely entry evidence", () => {
  const rec = {
    publishedAt: iso(start),
    plan: signal("late-quote"),
  };
  const quote = recommendationEvaluator.quoteOpportunity({
    quotes: [{ t: iso(start + 120000), bidPrice: 99.98, askPrice: 100.02 }],
    plan: rec.plan,
    publishedAt: rec.publishedAt,
  });
  assert.equal(quote.observed, false);
  assert.equal(quote.reason, "stale_quote");
});
test("horizon movement refuses a single bar as complete coverage", () => {
  const rec = {
    publishedAt: iso(start),
    plan: signal("single-horizon-bar"),
    provenance: { intradayFeed: "sip" },
  };
  const movement = recommendationEvaluator.horizonMovement({
    recommendation: rec,
    bars: [{ t: iso(start), o: 100, h: 101, l: 99, c: 100.5, v: 1000 }],
    horizon: "d0",
    timeframe: "1Min",
  });
  assert.equal(movement.workflowStatus, "retryable_error");
  assert.equal(movement.coverage.coverageStatus, "needs_data");
});
test("stale recommendation review jobs are reclaimed after lease expiry", () => {
  const archived = store.transaction(() =>
    recommendations.archiveSignal({ userId: "lease-user", signal: signal("lease-setup"), now: start + 3000 }),
  );
  const db = store.database();
  db.prepare("UPDATE recommendation_review_jobs SET state='evaluating', lease_owner='old', lease_until=?, due_at=? WHERE recommendation_id=?")
    .run(iso(start - 300000), iso(start - 600000), archived.id);
  const claimed = recommendations.dueJobs(start, 10, "new-owner").filter((job) => job.recommendation_id === archived.id);
  assert.equal(claimed.length, 5);
  assert.ok(claimed.every((job) => job.lease_owner === "new-owner"));
});
test("archive creates review jobs for plan and fixed movement horizons", () => {
  store.put("cache", "calendar", {
    date: "2026-09-08",
    rows: [
      { date: "2026-09-08", open: "09:30", close: "16:00" },
      { date: "2026-09-09", open: "09:30", close: "16:00" },
      { date: "2026-09-10", open: "09:30", close: "16:00" },
      { date: "2026-09-11", open: "09:30", close: "13:00" },
      { date: "2026-09-14", open: "09:30", close: "16:00" },
      { date: "2026-09-15", open: "09:30", close: "16:00" },
    ],
  });
  const archived = store.transaction(() =>
    recommendations.archiveSignal({ userId: "horizon-user", signal: signal("horizon-setup"), now: start + 4000 }),
  );
  const jobs = store.database().prepare("SELECT horizon FROM recommendation_review_jobs WHERE recommendation_id=? ORDER BY horizon").all(archived.id).map((row) => row.horizon);
  assert.deepEqual(jobs, ["d0", "d1", "d3", "d5", "plan"]);
  const d5 = store.database().prepare("SELECT due_at FROM recommendation_review_jobs WHERE recommendation_id=? AND horizon='d5'").get(archived.id);
  assert.equal(d5.due_at, "2026-09-15T20:20:00.000Z");
});
test("shadow candidate archive stores scan reason without creating a user recommendation", () => {
  const ok = recommendations.recordShadowCandidate({
    scanId: "scan-shadow",
    symbol: "SHDW",
    strategy: "orb15",
    decisionAt: iso(start),
    reasonCode: "rvol_below_threshold",
    features: { rvol: 1.5 },
  });
  assert.equal(ok, true);
  const row = store.database().prepare("SELECT * FROM shadow_candidates WHERE scan_id=? AND symbol=?").get("scan-shadow", "SHDW");
  assert.equal(row.reason_code, "rvol_below_threshold");
  assert.equal(recommendations.listForUser("scan-shadow", { limit: 10 }).rows.length, 0);
});
test("feedback dataset deduplicates recommendations and keeps shadow unlabeled", () => {
  const now = iso(start + 6000);
  store.transaction(() => recommendations.archiveSignal({ userId: "feedback-user", signal: signal("feedback-setup"), now: start + 6000 }));
  recommendations.recordShadowCandidate({
    scanId: "feedback-scan",
    symbol: "MISS",
    strategy: "orb15",
    decisionAt: now,
    reasonCode: "trigger_not_met",
    features: { rvol: 1.8 },
  });
  feedback.ensureShadowPolicy({ now });
  const dataset = feedback.buildDataset({ asOf: iso(start + 7000), horizon: "d5" });
  assert.ok(dataset.counts.publishedUniqueSetups >= 1);
  assert.ok(dataset.counts.shadowCandidates >= 1);
  const status = feedback.status();
  assert.equal(status.activePolicy.state, "shadow");
  assert.equal(status.note.includes("shadow"), true);
});
test("feedback gates block old labels without prospective replay validation", () => {
  const db = store.database();
  store.put("cache", "calendar", {
    date: "2026-09-16",
    rows: [
      { date: "2026-09-08", open: "09:30", close: "16:00" },
      { date: "2026-09-09", open: "09:30", close: "16:00" },
      { date: "2026-09-10", open: "09:30", close: "16:00" },
      { date: "2026-09-11", open: "09:30", close: "16:00" },
      { date: "2026-09-14", open: "09:30", close: "16:00" },
      { date: "2026-09-15", open: "09:30", close: "16:00" },
      { date: "2026-09-16", open: "09:30", close: "16:00" },
    ],
  });
  feedback.ensureShadowPolicy({ now: iso(start) });
  db.prepare("UPDATE policy_candidates SET state='shadow',created_at=?,updated_at=?,evidence_json=? WHERE policy_version=?")
    .run(iso(start), iso(start), JSON.stringify({ reason: "unit_reset" }), feedback.SHADOW_POLICY_VERSION);
  db.prepare(
    `INSERT OR REPLACE INTO feedback_datasets(id,dataset_version,as_of,label_horizon,policy_version,counts_json,coverage_json,checksum,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    "activation-dataset",
    "feedback:d5:activation",
    "2026-09-16T20:10:00.000Z",
    "d5",
    feedback.SHADOW_POLICY_VERSION,
    JSON.stringify({ total: 20, publishedUniqueSetups: 20, shadowCandidates: 0, prospectiveSetups: 0, shadowStartedAt: iso(start) }),
    JSON.stringify({ complete: 20, pending: 0, needsData: 0, unlabeled: 0 }),
    "activation-checksum",
    "2026-09-16T20:11:00.000Z",
  );
  for (let index = 0; index < 20; index++) {
    db.prepare(
      `INSERT OR REPLACE INTO feedback_dataset_rows(id,dataset_id,setup_id,recommendation_id,shadow_candidate_id,symbol,strategy,decision_at,feature_snapshot_json,label_json,coverage_status,sample_weight,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `activation-row-${index}`,
      "activation-dataset",
      `activation-setup-${index}`,
      `activation-rec-${index}`,
      null,
      `A${index}`,
      "orb15",
      iso(start - 86400000 + index * 1000),
      JSON.stringify({ featureSchemaVersion: feedback.FEATURE_SCHEMA_VERSION, strategy: "orb15", lane: "day", decisionAt: iso(start - 86400000 + index * 1000), featureAvailableAt: iso(start - 86400000 + index * 1000), rvol: index < 10 ? 1.2 : 4.2, adv20: 50_000_000, atrPct: 3, gapPct: null, decisionHourNy: 9, priceFreshnessMs: 1000, missingMask: {}, sourceVersions: {} }),
      JSON.stringify({ horizon: "d5", workflowStatus: "complete", outcomeStatus: index < 10 ? "no_observed_fill" : "target", metrics: { returnFromObservedReferencePct: index < 10 ? -2 : 8 } }),
      "complete",
      1,
      "2026-09-16T20:11:00.000Z",
    );
  }

  const result = feedback.evaluateGates({
    datasetVersion: "feedback:d5:activation",
    asOf: "2026-09-16T20:10:00.000Z",
  });

  assert.equal(result.gates.forwardSessions, 7);
  assert.equal(result.metrics.prospectiveResolvedSetups, 0);
  assert.equal(result.activation.activated, false);
  assert.match(result.reason, /prospective_evidence_insufficient/);
  assert.equal(feedback.activePolicy().state, "shadow");
});

test("feedback policy activates only with prospective v2 labels and completed validation", () => {
  const db = store.database();
  db.prepare(
    `INSERT OR REPLACE INTO feedback_datasets(id,dataset_version,as_of,label_horizon,policy_version,counts_json,coverage_json,checksum,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    "activation-dataset-v2",
    "feedback:d5:activation-v2",
    "2026-09-16T20:10:00.000Z",
    "d5",
    feedback.SHADOW_POLICY_VERSION,
    JSON.stringify({ total: 20, publishedUniqueSetups: 20, shadowCandidates: 0, prospectiveSetups: 20, shadowStartedAt: iso(start) }),
    JSON.stringify({ complete: 20, pending: 0, needsData: 0, unlabeled: 0, replay: { status: "complete" }, validation: { advantage: true } }),
    "activation-checksum-v2",
    "2026-09-16T20:11:00.000Z",
  );
  for (let index = 0; index < 20; index++) {
    db.prepare(
      `INSERT OR REPLACE INTO feedback_dataset_rows(id,dataset_id,setup_id,recommendation_id,shadow_candidate_id,symbol,strategy,decision_at,feature_snapshot_json,label_json,coverage_status,sample_weight,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `activation-v2-row-${index}`,
      "activation-dataset-v2",
      `activation-v2-setup-${index}`,
      `activation-v2-rec-${index}`,
      null,
      `B${index}`,
      "orb15",
      iso(start + index * 1000),
      JSON.stringify({ featureSchemaVersion: feedback.FEATURE_SCHEMA_VERSION, strategy: "orb15", lane: "day", decisionAt: iso(start + index * 1000), featureAvailableAt: iso(start + index * 1000), rvol: index < 10 ? 1.2 : 4.2, adv20: 50_000_000, atrPct: 3, gapPct: null, decisionHourNy: 9, priceFreshnessMs: 1000, missingMask: {}, sourceVersions: {} }),
      JSON.stringify({ horizon: "d5", workflowStatus: "complete", outcomeStatus: index < 10 ? "time_exit" : "target", metrics: { returnFromObservedReferencePct: index < 10 ? -2 : 8 } }),
      "complete",
      1,
      "2026-09-16T20:11:00.000Z",
    );
  }
  const result = feedback.evaluateGates({
    datasetVersion: "feedback:d5:activation-v2",
    asOf: "2026-09-16T20:10:00.000Z",
  });

  assert.equal(result.training.trained, true, JSON.stringify(result));
  assert.equal(result.activation.activated, true);
  assert.equal(feedback.activePolicy().state, "active_limited");
  assert.ok(feedback.activePolicy().policyVersion.startsWith("feedback-learned-"));
  assert.equal(feedback.activePolicy().hyperparams.learner, feedback.LEARNER_VERSION);
  const low = feedback.scoreCandidate({ symbol: "LOWLEARN", candidateFor: "orb15", rvol: 1.2, avgDollarVolume20d: 50_000_000, daily: { atr14: 3, price: 100 }, decisionAt: iso(start) });
  const high = feedback.scoreCandidate({ symbol: "HIGHLEARN", candidateFor: "orb15", rvol: 4.2, avgDollarVolume20d: 50_000_000, daily: { atr14: 3, price: 100 }, decisionAt: iso(start) });
  assert.equal(high.learnedScore > low.learnedScore, true);
  feedback.rollbackPolicy({ reason: "unit_cleanup", now: "2026-09-16T20:12:00.000Z" });
});
test("active feedback policy can reorder only inside an existing strategy list", () => {
  const now = iso(start + 8000);
  store.database().prepare(
    `INSERT OR REPLACE INTO policy_candidates(policy_version,state,feature_schema_version,hyperparams_json,training_dataset_version,train_cutoff_at,gate_version,evidence_json,previous_policy_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "unit-active-policy",
    "active_limited",
    feedback.FEATURE_SCHEMA_VERSION,
    JSON.stringify({ weights: { rvol: 1, liquidity: 0, atr: 0 } }),
    null,
    null,
    feedback.GATE_VERSION,
    JSON.stringify({ resolvedSetups: 200, uncertainty: "unit" }),
    feedback.BASELINE_POLICY_VERSION,
    now,
    now,
  );
  const list = [
    { symbol: "LOW", rvol: 1.2, avgDollarVolume20d: 50_000_000, daily: { atr14: 1, price: 100 }, decisionAt: now },
    { symbol: "HIGH", rvol: 4.2, avgDollarVolume20d: 50_000_000, daily: { atr14: 1, price: 100 }, decisionAt: now },
  ];
  const ranked = feedback.maybeApplyPolicyToList(list);
  assert.equal(ranked.applied, true);
  assert.equal(ranked.rows[0].symbol, "HIGH");
  feedback.rollbackPolicy({ reason: "unit_cleanup", now: iso(start + 9000) });
});
test("simulation cannot enter before signal and cannot reuse entry candle", () => {
  config.save({ fees: "free", slippagePct: 0 }, USER);
  const s = signal("simulation");
  tracking.simulate(USER, s, { price: 100, at: s.createdAt }, start);
  assert.equal(store.getUser(USER, "trade", "sim:simulation"), null);
  tracking.simulate(USER, s, { price: 100, at: iso(start + 30000) }, start + 30000);
  let trade = store.getUser(USER, "trade", "sim:simulation");
  assert.ok(trade);
  tracking.simulate(USER, s, { price: 100, at: iso(start + 40000) }, start + 40000);
  assert.equal(store.listUser(USER, "trade").filter((t) => t.id === trade.id).length, 1);
  trade = tracking.track(
    USER,
    trade,
    [bar(0, { l: 90, h: 110 })],
    null,
    start + 300000,
  );
  assert.equal(trade.status, "open");
  trade = tracking.track(
    USER,
    trade,
    [bar(1, { o: 95, l: 94, h: 110 })],
    null,
    start + 600000,
  );
  assert.equal(trade.exit, 95);
  assert.equal(trade.exitReason, "stop");
});
test("personal stop alert never sells; actual fills and late reports are distinct", () => {
  const s = signal("personal");
  store.putUser(USER, "signal", s.id, s);
  assert.throws(() =>
    tracking.personalEntry(
      USER,
      s.id,
      { price: 100, shares: 1, executedAt: iso(start - 1000) },
      start + 60000,
    ),
  );
  let trade = tracking.personalEntry(
    USER,
    s.id,
    { price: 100, shares: 0.2, fees: 0, executedAt: iso(start + 1000) },
    start + 60000,
  );
  assert.equal(trade.enteredAt, iso(start + 1000));
  trade = tracking.track(
    USER,
    trade,
    [],
    { price: 97, at: iso(start + 120000) },
    start + 120000,
  );
  assert.equal(trade.status, "open");
  assert.equal(trade.exitAlert, "stop");
  assert.throws(() =>
    tracking.personalClose(
      USER,
      trade.id,
      { price: 98, executedAt: iso(start) },
      start + 180000,
    ),
  );
  trade = tracking.personalClose(
    USER,
    trade.id,
    { price: 98, fees: 0.1 },
    start + 180000,
  );
  assert.equal(trade.pnl, -0.4);
  const stats = tracking.statistics(store.listUser(USER, "trade"));
  assert.equal(stats.find((s) => s.source === "personal").n, 1);
});
test("time exit uses final completed bar even if no fresh quote remains", () => {
  const trade = {
    ...signal("timed"),
    source: "simulation",
    status: "open",
    shares: 1,
    entryFee: 0,
    feeMode: "free",
    enteredAt: iso(start),
    lastCheckedAt: iso(start),
    deadline: iso(start + 600000),
  };
  const result = tracking.track(
    USER,
    trade,
    [bar(0), bar(1, { c: 101 })],
    null,
    start + 900000,
  );
  assert.equal(result.exitReason, "time");
  assert.equal(result.exit, 101);
  assert.equal(result.closedAt, trade.deadline);
});
test("scheduler monitors an existing position with no browser requests", async () => {
  const engine = require("../src/autopilot/engine");
  const originals = {
    isConfigured: alpaca.isConfigured,
    getClock: alpaca.getClock,
    getCalendar: alpaca.getCalendar,
    getSnapshots: alpaca.getSnapshots,
    getIntradayBars: alpaca.getIntradayBars,
    flush: notices.flush,
  };
  try {
    users.session({ userId: "scheduler-user", code: "1234" });
    config.save({ enabled: false }, "scheduler-user");
    const now = Date.now();
    const date = market.nyDate(now);
    const trade = {
      ...signal("background"),
      id: "background",
      source: "personal",
      status: "open",
      shares: 1,
      entryFee: 0,
      feeMode: "free",
      enteredAt: iso(now - 600000),
      lastCheckedAt: iso(now - 600000),
      deadline: iso(now + 3600000),
    };
    store.putUser("scheduler-user", "trade", trade.id, trade);
    alpaca.isConfigured = () => true;
    alpaca.getClock = async () => ({
      is_open: false,
      next_open: iso(now + 86400000),
    });
    alpaca.getCalendar = async () => [{ date, open: "09:30", close: "16:00" }];
    alpaca.getSnapshots = async () =>
      new Map([["TEST", { latestTrade: { p: 97, t: iso(now) } }]]);
    alpaca.getIntradayBars = async () => new Map();
    notices.flush = async () => {};
    await engine.tick();
    assert.equal(store.getUser("scheduler-user", "trade", trade.id).exitAlert, "stop");
    assert.ok(store.get("runtime", "engine").heartbeatAt);
  } finally {
    Object.assign(alpaca, { ...originals });
    notices.flush = originals.flush;
  }
});
test("full scan produces a fresh priced signal and deduplicates repeated scans", async (t) => {
  const engine = require("../src/autopilot/engine");
  const now = start + 1200000;
  t.mock.method(Date, "now", () => now);
  users.session({ userId: "scan-user", code: "1234" });
  config.save({ enabled: true, fees: "free" }, "scan-user");
  const calendar = Array.from({ length: 6 }, (_, i) => ({
    date: market.nyDate(start - (5 - i) * 86400000),
    open: start - (5 - i) * 86400000,
    close: start - (5 - i) * 86400000 + 23400000,
  }));
  const today = calendar.at(-1);
  store.put("cache", "universe", {
    date: today.date,
    rows: [{ symbol: "SCAN", exchange: "NASDAQ" }],
  });
  store.put("cache", "v3-universe", {
    date: today.date,
    rows: [
      {
        symbol: "SCAN",
        companyName: "Scan Corp",
        exchange: "NASDAQ",
        close: 100,
        avgDollarVolume20d: 5_000_000,
        dailyFeed: "sip",
        lastSessionDate: market.nyDate(start - 86400000),
      },
    ],
    diagnostics: { complete: true },
  });
  const dailyBars = Array.from({ length: 20 }, (_, index) => ({
    t: iso(start - (20 - index) * 86400000),
    o: 100,
    h: 102,
    l: 98,
    c: 100,
    v: 1000,
  }));
  store.put("history", autopilotHistory.cacheKey({ symbol: "SCAN", feed: "sip", timeframe: "1Day" }), {
    symbol: "SCAN",
    feed: "sip",
    timeframe: "1Day",
    adjustment: "split",
    schema: "v1",
    bars: dailyBars,
    lastSessionDate: market.nyDate(start - 86400000),
    fetchedAt: iso(now),
  });
  store.put("news", "SCAN", { at: now, count: 0 });
  const bars = calendar.flatMap((session, i) =>
    Array.from({ length: 4 }, (_, k) => ({
      ...bar(k, i === 5 && k === 3 ? { c: 102, h: 103 } : {}),
      t: iso(session.open + k * 300000),
      v: i === 5 ? 200 : 100,
    })),
  );
  t.mock.method(
    alpaca,
    "getSnapshots",
    async () =>
      new Map([
        [
          "SCAN",
          {
            dailyBar: { t: iso(start), v: 800, c: 102 },
            latestTrade: { p: 102, t: iso(now) },
          },
        ],
      ]),
  );
  t.mock.method(
    alpaca,
    "getBarsDetailed",
    async ({ timeframe }) =>
      timeframe === "5Min"
        ? { bars: new Map([["SCAN", bars]]), complete: true, failedSymbols: [], errors: [] }
        : { bars: new Map([["SCAN", dailyBars]]), complete: true, failedSymbols: [], errors: [] },
  );
  t.mock.method(alpaca, "openStream", () => ({ readyState: 1, close() {} }));
  try {
    await engine.scan(now, calendar, today);
    const rows = store.listUser("scan-user", "signal").filter((s) => s.ticker === "SCAN");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entry, 102);
    assert.equal(rows[0].strategy, "orb15");
    assert.equal(rows[0].status, "active");
    await engine.scan(now, calendar, today);
    assert.equal(
      store.listUser("scan-user", "signal").filter((s) => s.ticker === "SCAN").length,
      1,
    );
  } finally {
    engine.stop();
  }
});

test("production API creates a browser profile and rejects unauthorized writes", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/autopilot`;
  try {
    assert.equal((await fetch(`${url}/dashboard`)).status, 401);
    const session = await (
      await fetch(`${url}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "1234" }),
      })
    ).json();
    assert.ok(session.userId);
    assert.equal(
      (
        await fetch(`${url}/dashboard`, {
          headers: {
            Authorization: "Bearer 1234",
            "X-TradeSense-User": session.userId,
          },
        })
      ).status,
      200,
    );
    const recResponse = await fetch(`${url}/recommendations`, {
      headers: {
        Authorization: "Bearer 1234",
        "X-TradeSense-User": session.userId,
      },
    });
    assert.equal(recResponse.status, 200);
    const recPayload = await recResponse.json();
    assert.ok(Array.isArray(recPayload.rows));
    assert.equal(
      (
        await fetch(`${url}/settings`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer 1234",
            "X-TradeSense-User": session.userId,
            Origin: "https://wrong.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((r) => server.close(r));
    if (oldEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnv;
  }
});

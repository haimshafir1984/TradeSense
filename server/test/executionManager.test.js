const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODULES = [
  "../src/autopilot/store", "../src/autopilot/market", "../src/execution/positions", "../src/execution/autonomy",
  "../src/execution/orders", "../src/execution/closeRequests", "../src/execution/riskProfile", "../src/execution/risk",
  "../src/execution/exitManager",
];

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-manager-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "m.sqlite");
  process.env.EXECUTION_QUEUE_ENABLED = "true";
  process.env.EXECUTION_BROKER_ACCOUNT_ID = "102992";
  for (const name of MODULES) delete require.cache[require.resolve(name)];
  const ctx = { scratch };
  ctx.store = require("../src/autopilot/store");
  ctx.positions = require("../src/execution/positions");
  ctx.autonomy = require("../src/execution/autonomy");
  ctx.commands = require("../src/execution/closeRequests");
  ctx.profile = require("../src/execution/riskProfile");
  ctx.risk = require("../src/execution/risk");
  ctx.manager = require("../src/execution/exitManager");
  return ctx;
}

function cleanup(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  delete process.env.EXECUTION_QUEUE_ENABLED;
  delete process.env.EXECUTION_BROKER_ACCOUNT_ID;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

const NOW = Date.parse("2026-10-14T15:00:00Z"); // Wednesday 11:00 in New York

function pos(ticket, overrides = {}) {
  return { ticket, symbol: "Apple#", side: "buy", lots: 100, openPrice: 100, currentPrice: 100, stopLoss: 95, profit: 0, managed: true, minLot: 10, lotStep: 5, ...overrides };
}

function report(ctx, list, { now = NOW, equity = 10000, closedToday = 0 } = {}) {
  ctx.autonomy.heartbeat({ accountId: "102992", isDemo: true }, now);
  ctx.positions.save({ accountId: "102992", isDemo: true, currency: "USD", balance: equity, equity, profit: 0, closedToday, positions: list }, now);
}

function setProfile(ctx, patch) {
  return ctx.profile.save(patch);
}

const TIERS = [{ triggerPct: 3, sellPct: 50 }, { triggerPct: 6, sellPct: 25 }, { triggerPct: null, sellPct: null }];

// Plays the part of the EA: claim and complete the pending command.
function eaComplete(ctx, id, patch = {}, now = NOW) {
  ctx.commands.transition(id, "claimed", {}, now);
  return ctx.commands.transition(id, "closed", patch, now);
}

test("risk profile validation: defaults, required loss limit, tier rules, short stays off", () => {
  const ctx = load();
  try {
    const d = ctx.profile.read();
    assert.equal(d.dailyLoss.pct, 7);
    assert.equal(d.dailyLoss.action, "close_all");
    assert.equal(d.maxConcurrent, null);
    assert.equal(d.stopLossPct, null);
    assert.equal(d.endOfDay.mode, "close");
    assert.equal(d.autoManage, true);
    assert.deepEqual(d.takeProfit.tiers.map((t) => [t.triggerPct, t.sellPct]), [[3, null], [6, null], [null, null]]);
    assert.throws(() => ctx.profile.save({ dailyLoss: { pct: null, amountUsd: null } }), /חובה/);
    assert.throws(() => ctx.profile.save({ takeProfit: { tiers: [{ triggerPct: 6, sellPct: 10 }, { triggerPct: 3, sellPct: 10 }, {}] } }), /גבוה מהמדרגה הקודמת/);
    assert.throws(() => ctx.profile.save({ takeProfit: { tiers: [{ triggerPct: 3, sellPct: 80 }, { triggerPct: 6, sellPct: 30 }, {}] } }), /100%/);
    assert.throws(() => ctx.profile.save({ takeProfit: { stopAfter: "manual" } }), /סטופ ידני/);
    assert.throws(() => ctx.profile.save({ maxConcurrent: 0 }), /מספר שלם/);
    const saved = ctx.profile.save({ maxConcurrent: 2, stopLossPct: 1.5, shortEnabled: true });
    assert.equal(saved.shortEnabled, false);
    assert.equal(ctx.profile.read().maxConcurrent, 2);
    assert.equal(ctx.profile.read().stopLossPct, 1.5);
    assert.equal(ctx.profile.save({ maxConcurrent: null }).maxConcurrent, null);
  } finally {
    cleanup(ctx);
  }
});

test("daily base is fixed at the first activation of the US day, survives restarts and resets next day", () => {
  const ctx = load();
  try {
    assert.throws(() => ctx.profile.ensureDayBase(NOW), /MT4/);
    report(ctx, [], { equity: 10000 });
    assert.equal(ctx.profile.ensureDayBase(NOW).baseEquity, 10000);
    report(ctx, [], { equity: 9700, now: NOW + 3600_000 });
    // stop/start later the same day keeps the original base
    assert.equal(ctx.profile.ensureDayBase(NOW + 3600_000).baseEquity, 10000);
    const evaluation = ctx.profile.evaluateDay(NOW + 3600_000);
    assert.equal(evaluation.loss, 300);
    // next trading day: no base until trading is activated again
    const tomorrow = NOW + 24 * 3600_000;
    assert.equal(ctx.profile.evaluateDay(tomorrow).hasBase, false);
    report(ctx, [], { equity: 9700, now: tomorrow });
    assert.equal(ctx.profile.ensureDayBase(tomorrow).baseEquity, 9700);
  } finally {
    cleanup(ctx);
  }
});

test("loss limit uses the stricter of percent and dollars, includes unrealized loss, and latches for the day", () => {
  const ctx = load();
  try {
    setProfile(ctx, { dailyLoss: { pct: 7, amountUsd: 200, action: "close_all" } });
    report(ctx, [], { equity: 10000 });
    ctx.profile.ensureDayBase(NOW);
    assert.equal(ctx.profile.evaluateDay(NOW).limit, 200);
    report(ctx, [pos("1", { profit: -150 })], { equity: 9850, now: NOW + 1000 });
    assert.equal(ctx.profile.evaluateDay(NOW + 1000).breached, false);
    report(ctx, [pos("1", { profit: -250 })], { equity: 9750, now: NOW + 2000 });
    assert.equal(ctx.profile.evaluateDay(NOW + 2000).breached, true);
    // equity recovers; the day stays stopped
    report(ctx, [], { equity: 10100, now: NOW + 3000 });
    assert.equal(ctx.profile.evaluateDay(NOW + 3000).breached, true);
  } finally {
    cleanup(ctx);
  }
});

function signal(overrides = {}) {
  return { id: "s1", status: "active", brokerSymbol: "Apple", side: "buy", expiresAt: new Date(NOW + 600000).toISOString(), entry: 100, stop: 98, target: 104, sizing: { shares: 10 }, ...overrides };
}

test("entry gate fails closed and enforces day base, loss limit, concurrency and no shorts", () => {
  const ctx = load();
  try {
    const args = { userId: "u1", brokerAccountId: "102992", symbol: "Apple", now: NOW };
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal() }), /עדכני/);
    report(ctx, [], { equity: 10000 });
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal() }), /בסיס ההפסד/);
    ctx.profile.ensureDayBase(NOW);
    assert.equal(ctx.risk.validateSignal({ ...args, signal: signal() }).quantity, 10);
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal({ side: "sell", stop: 102, entry: 100, target: 96 }) }), /מכירה בחסר/);
    // concurrency: only TradeSense-managed positions and unconfirmed orders count
    setProfile(ctx, { maxConcurrent: 2 });
    report(ctx, [pos("1", { symbol: "Other1#" }), pos("2", { symbol: "Other2#", managed: false }), pos("3", { symbol: "Other3#", managed: false })]);
    // one symbol, one position: the same symbol is blocked whatever the "#" suffix
    report(ctx, [pos("9", { symbol: "Apple#" })]);
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal() }), /כבר יש פוזיציה/);
    report(ctx, [pos("1", { symbol: "Other1#" }), pos("2", { symbol: "Other2#", managed: false }), pos("3", { symbol: "Other3#", managed: false })]);
    assert.ok(ctx.risk.validateSignal({ ...args, signal: signal() }));
    ctx.store.putUser("u1", "executionOrder", "o1", { id: "o1", status: "submitted" });
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal() }), /במקביל/);
    // lowering the limit below the open count closes nothing, it only blocks entries
    setProfile(ctx, { maxConcurrent: 1 });
    assert.equal(ctx.positions.current(NOW).positions.length, 3);
    // loss limit
    setProfile(ctx, { maxConcurrent: null });
    report(ctx, [], { equity: 9200 });
    assert.throws(() => ctx.risk.validateSignal({ ...args, signal: signal() }), /ההפסד היומי/);
  } finally {
    cleanup(ctx);
  }
});

test("fixed stop loss percentage is applied to long entries only when configured", () => {
  const ctx = load();
  try {
    const base = { entry: 100, maxEntry: 101, side: "buy", stop: 98 };
    assert.equal(ctx.risk.applyStopPolicy(base).stop, 98);
    setProfile(ctx, { stopLossPct: 2 });
    const adjusted = ctx.risk.applyStopPolicy(base);
    assert.equal(adjusted.stop, 98.98);
    assert.ok(adjusted.stop < base.entry);
  } finally {
    cleanup(ctx);
  }
});

test("manager does nothing while automatic management is off, and waits when MT4 is stale", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: false, takeProfit: { tiers: TIERS } });
    report(ctx, [pos("1", { currentPrice: 104 })]);
    const off = await ctx.manager.evaluate({ now: NOW });
    assert.equal(off.enabled, false);
    assert.equal(ctx.commands.listAll().length, 0);
    setProfile(ctx, { autoManage: true });
    const stale = await ctx.manager.evaluate({ now: NOW + 200_000 });
    assert.equal(ctx.commands.listAll().length, 0);
    assert.ok(stale.warnings.some((w) => /עדכני/.test(w)));
  } finally {
    cleanup(ctx);
  }
});

test("take-profit tiers: partial sell, confirmation by MT4, new ticket, second tier, no duplicates", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, takeProfit: { tiers: TIERS, stopAfter: "breakeven" }, endOfDay: { mode: "keep" } });
    report(ctx, [pos("1", { currentPrice: 102 })]);
    await ctx.manager.evaluate({ now: NOW });
    assert.equal(ctx.commands.listAll().length, 0, "below the first trigger");
    report(ctx, [pos("1", { currentPrice: 103.2 })], { now: NOW + 15_000 });
    await ctx.manager.evaluate({ now: NOW + 15_000 });
    const first = ctx.commands.listAll();
    assert.equal(first.length, 1);
    assert.equal(first[0].type, "partial_close");
    assert.equal(first[0].lots, 50);
    // repeated evaluations do not duplicate the order while it is in flight
    await ctx.manager.evaluate({ now: NOW + 16_000 });
    await ctx.manager.evaluate({ now: NOW + 17_000 });
    assert.equal(ctx.commands.listAll().length, 1);
    eaComplete(ctx, first[0].id, { closePrice: 103.2, remainingTicket: "2" }, NOW + 18_000);
    report(ctx, [pos("2", { lots: 50, currentPrice: 103.4 })], { now: NOW + 30_000 });
    await ctx.manager.evaluate({ now: NOW + 30_000 });
    const record = ctx.store.list("executionPosition")[0];
    assert.equal(record.ticket, "2");
    assert.equal(record.soldLots, 50);
    assert.equal(record.tiers[1].status, "done");
    // the stop moves to the entry price after the profit was taken, once
    const stopMoves = ctx.commands.listAll().filter((c) => c.type === "modify_stop");
    assert.equal(stopMoves.length, 1);
    assert.equal(stopMoves[0].stopLoss, 100);
    eaComplete(ctx, stopMoves[0].id, {}, NOW + 31_000);
    // second tier: 25% of the ORIGINAL position
    report(ctx, [pos("2", { lots: 50, currentPrice: 106.1, stopLoss: 100 })], { now: NOW + 45_000 });
    await ctx.manager.evaluate({ now: NOW + 45_000 });
    const second = ctx.commands.listAll().find((c) => c.type === "partial_close" && c.status === "pending");
    assert.equal(second.lots, 25);
    await ctx.manager.evaluate({ now: NOW + 46_000 });
    assert.equal(ctx.commands.listAll().filter((c) => c.type === "partial_close").length, 2);
    assert.equal(ctx.commands.listAll().filter((c) => c.type === "modify_stop").length, 1);
  } finally {
    cleanup(ctx);
  }
});

test("a price gap over several tiers sells the combined quantity once", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, takeProfit: { tiers: TIERS }, endOfDay: { mode: "keep" } });
    report(ctx, [pos("1", { currentPrice: 107 })]);
    await ctx.manager.evaluate({ now: NOW });
    const cmds = ctx.commands.listAll();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].lots, 75, "50% + 25% of 100");
    await ctx.manager.evaluate({ now: NOW + 1000 });
    assert.equal(ctx.commands.listAll().length, 1);
  } finally {
    cleanup(ctx);
  }
});

test("tier sizes below the broker minimum are skipped safely, not invented", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, takeProfit: { tiers: [{ triggerPct: 3, sellPct: 5 }, { triggerPct: 6, sellPct: null }, {}] }, endOfDay: { mode: "keep" } });
    report(ctx, [pos("1", { currentPrice: 104 })]);
    await ctx.manager.evaluate({ now: NOW });
    assert.equal(ctx.commands.listAll().length, 0);
    assert.equal(ctx.store.list("executionPosition")[0].tiers[1].status, "skipped");
    // a sale that would leave less than the minimum is skipped too
    const ctx2 = ctx;
    ctx2.store.remove("executionPosition", ctx.store.list("executionPosition")[0].id);
    setProfile(ctx, { takeProfit: { tiers: [{ triggerPct: 3, sellPct: 90 }, { triggerPct: 6, sellPct: null }, {}] } });
    report(ctx, [pos("5", { lots: 100, minLot: 20, lotStep: 10, currentPrice: 104 })], { now: NOW + 20_000 });
    await ctx.manager.evaluate({ now: NOW + 20_000 });
    assert.equal(ctx.commands.listAll().length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("a failed or unknown close is shown, never retried automatically, and unknown is resolved from MT4 data", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, takeProfit: { tiers: TIERS }, endOfDay: { mode: "keep" } });
    report(ctx, [pos("1", { currentPrice: 103.5 })]);
    await ctx.manager.evaluate({ now: NOW });
    const cmd = ctx.commands.listAll()[0];
    ctx.commands.transition(cmd.id, "claimed", {}, NOW + 1000);
    ctx.commands.transition(cmd.id, "rejected", { error: "order_close_rejected_132" }, NOW + 2000);
    report(ctx, [pos("1", { currentPrice: 103.6 })], { now: NOW + 15_000 });
    await ctx.manager.evaluate({ now: NOW + 15_000 });
    await ctx.manager.evaluate({ now: NOW + 16_000 });
    assert.equal(ctx.commands.listAll().length, 1, "no automatic retry");
    assert.equal(ctx.store.list("executionPosition")[0].tiers[1].status, "failed");
    assert.match(ctx.manager.view(NOW + 16_000).positions[0].tiers[1].note, /132/);

    // unknown close: the position vanished from MT4's report, so the close is confirmed by MT4 data
    const ctx2 = ctx;
    report(ctx2, [pos("9")], { now: NOW + 100_000 });
    const user = ctx2.commands.create({ ticket: "9", userId: "u1", now: NOW + 100_000 }).request;
    ctx2.commands.transition(user.id, "claimed", {}, NOW + 101_000);
    ctx2.commands.transition(user.id, "unknown", { error: "order_close_ambiguous_128" }, NOW + 102_000);
    report(ctx2, [], { now: NOW + 115_000 });
    await ctx2.manager.evaluate({ now: NOW + 115_000 });
    assert.equal(ctx2.commands.get(user.id).status, "closed");
  } finally {
    cleanup(ctx);
  }
});

test("daily loss limit closes only TradeSense-managed positions, once, and the action can be 'stop new entries only'", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, dailyLoss: { pct: 7, amountUsd: null, action: "close_all" }, endOfDay: { mode: "keep" } });
    report(ctx, [], { equity: 10000 });
    ctx.profile.ensureDayBase(NOW);
    report(ctx, [pos("1"), pos("2", { managed: false })], { equity: 9200, now: NOW + 1000 });
    await ctx.manager.evaluate({ now: NOW + 1000 });
    const cmds = ctx.commands.listAll();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].ticket, "1");
    assert.equal(cmds[0].type, "close");
    await ctx.manager.evaluate({ now: NOW + 2000 });
    assert.equal(ctx.commands.listAll().length, 1);
    // closing fails: reported, not retried, MT4 data decides
    ctx.commands.transition(cmds[0].id, "claimed", {}, NOW + 3000);
    ctx.commands.transition(cmds[0].id, "rejected", { error: "order_close_rejected_4108" }, NOW + 4000);
    report(ctx, [pos("1"), pos("2", { managed: false })], { equity: 9150, now: NOW + 16_000 });
    await ctx.manager.evaluate({ now: NOW + 16_000 });
    assert.equal(ctx.commands.listAll().length, 1);
    assert.equal(ctx.profile.evaluateDay(NOW + 16_000).breached, true);
  } finally {
    cleanup(ctx);
  }
  const ctx2 = load();
  try {
    setProfile(ctx2, { autoManage: true, dailyLoss: { pct: 7, amountUsd: null, action: "stop_new" }, endOfDay: { mode: "keep" } });
    report(ctx2, [], { equity: 10000 });
    ctx2.profile.ensureDayBase(NOW);
    report(ctx2, [pos("1")], { equity: 9000, now: NOW + 1000 });
    await ctx2.manager.evaluate({ now: NOW + 1000 });
    assert.equal(ctx2.commands.listAll().length, 0);
    assert.throws(() => ctx2.risk.validateSignal({ userId: "u1", brokerAccountId: "102992", symbol: "Apple", signal: signal(), now: NOW + 1000 }), /ההפסד היומי/);
  } finally {
    cleanup(ctx2);
  }
});

test("end of day closes managed positions one minute before the US close, only inside the window, once", async () => {
  const ctx = load();
  try {
    const close = Date.parse("2026-10-14T20:00:00Z");
    const early = Date.parse("2026-11-27T18:00:00Z"); // an early-close day is just a different session time
    const session = (c) => async () => ({ date: "2026-10-14", close: c });
    setProfile(ctx, { autoManage: true, endOfDay: { mode: "close" } });
    report(ctx, [pos("1"), pos("2", { managed: false })], { now: close - 5 * 60_000 });
    await ctx.manager.evaluate({ now: close - 5 * 60_000, getSession: session(close) });
    assert.equal(ctx.commands.listAll().length, 0, "too early");
    report(ctx, [pos("1"), pos("2", { managed: false })], { now: close - 50_000 });
    const status = await ctx.manager.evaluate({ now: close - 50_000, getSession: session(close) });
    assert.equal(ctx.commands.listAll().length, 1);
    assert.equal(ctx.commands.listAll()[0].ticket, "1");
    assert.equal(status.eod.available, true);
    await ctx.manager.evaluate({ now: close - 40_000, getSession: session(close) });
    assert.equal(ctx.commands.listAll().length, 1);
    // failure is visible and never retried the next morning
    const cmd = ctx.commands.listAll()[0];
    ctx.commands.transition(cmd.id, "claimed", {}, close - 30_000);
    ctx.commands.transition(cmd.id, "rejected", { error: "market_closed" }, close - 20_000);
    const tomorrow = close + 15 * 3600_000;
    report(ctx, [pos("1")], { now: tomorrow });
    await ctx.manager.evaluate({ now: tomorrow, getSession: async () => ({ date: "2026-10-15", close: tomorrow + 6 * 3600_000 }) });
    assert.equal(ctx.commands.listAll().length, 1);
    // an early-close session moves the window
    assert.ok(early > close);
  } finally {
    cleanup(ctx);
  }
  const ctx2 = load();
  try {
    setProfile(ctx2, { autoManage: true, endOfDay: { mode: "close" } });
    report(ctx2, [pos("1")]);
    const status = await ctx2.manager.evaluate({ now: NOW, getSession: async () => { throw new Error("calendar unavailable"); } });
    assert.equal(status.eod.available, false);
    assert.equal(ctx2.commands.listAll().length, 0, "without a trading calendar nothing is closed automatically");
  } finally {
    cleanup(ctx2);
  }
});

test("a quantity that does not match MT4 halts automation for that position", async () => {
  const ctx = load();
  try {
    setProfile(ctx, { autoManage: true, takeProfit: { tiers: TIERS }, endOfDay: { mode: "keep" } });
    report(ctx, [pos("1", { currentPrice: 103.5 })]);
    await ctx.manager.evaluate({ now: NOW });
    const cmd = ctx.commands.listAll()[0];
    eaComplete(ctx, cmd.id, { remainingTicket: "2" }, NOW + 1000);
    // MT4 reports 80 lots left although 50 were sold from 100
    report(ctx, [pos("2", { lots: 80, currentPrice: 107 })], { now: NOW + 15_000 });
    await ctx.manager.evaluate({ now: NOW + 15_000 });
    assert.match(ctx.store.list("executionPosition")[0].halted, /שונה מהמצופה/);
    await ctx.manager.evaluate({ now: NOW + 30_000 });
    assert.equal(ctx.commands.listAll().filter((c) => c.type !== "close").length, 1, "nothing further is sent for that position");
  } finally {
    cleanup(ctx);
  }
});

test("system commands never target manually opened positions; user close still can", () => {
  const ctx = load();
  try {
    report(ctx, [pos("1"), pos("2", { managed: false })]);
    assert.throws(() => ctx.commands.enqueue({ type: "close", ticket: "2", dedupeKey: "x", now: NOW }), /אינה מנוהלת/);
    assert.equal(ctx.commands.create({ ticket: "2", userId: "u1", now: NOW }).request.type, "close");
    assert.throws(() => ctx.commands.enqueue({ type: "partial_close", ticket: "1", lots: 100, dedupeKey: "y", now: NOW }), /כמות סגירה/);
    assert.throws(() => ctx.commands.enqueue({ type: "modify_stop", ticket: "1", stopLoss: 0, dedupeKey: "z", now: NOW }), /סטופ/);
  } finally {
    cleanup(ctx);
  }
});

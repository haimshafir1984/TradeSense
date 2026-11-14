// Multi-day follow-up of the shadow signals (data collection only, no effect on trading or on the intraday shadow fields).
// Question it answers: how would the same signals, with the same stop and target, have done if held for up to 5 trading days
// instead of being closed at the end of the day? Uses free SIP daily bars (one batched call, once per phase of the day).
//
// Policy simulated ("hold5"): stop and target of the signal stay fixed. A signal already resolved on its own day keeps that
// result. Otherwise, for each following day: an opening gap at or below the stop exits at the open (worse than -1R);
// else the low touching the stop exits at the stop; else the high touching the target exits at the target (a day that touches
// both counts as the stop: pessimistic, like the intraday shadow); after day 5 the exit is the close.
// The per-day arrays are also stored so other exit rules can be replayed later without new data.
const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");
const alpaca = require("../providers/alpacaService");
const calendar = require("./session");

const KIND = "alpacaTrader:shadow";
const HOLD_DAYS = 5;
const GIVE_UP_DAYS = 14; // calendar days after the signal: stop waiting for the missing daily bars
const MAX_PER_RUN = 300; // bounds the work (and SQLite writes) of one run
const POST_CLOSE_DELAY_MS = 20 * 60000; // the SIP daily bar of today exists only after the close (+15 min data delay)

const finite = (v) => Number.isFinite(Number(v));

// Pure: rec = a shadow record, bars = ascending daily bars [{date, o, h, l, c}] that include the signal's own day,
// today = the New York date of the run (a record that stays incomplete for GIVE_UP_DAYS is closed out instead of retried forever).
function simulate(rec, bars, today) {
  const day0 = bars.find((b) => b.date === rec.date);
  const after = bars.filter((b) => b.date > rec.date).slice(0, HOLD_DAYS);
  const calendarAge = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${rec.date}T12:00:00Z`)) / 86400000;
  const complete = after.length >= HOLD_DAYS;
  if (!complete && calendarAge < GIVE_UP_DAYS) return null; // wait for more days
  const { entry, stop, risk } = rec;
  const target = finite(rec.target) ? Number(rec.target) : null;
  const R = (price) => (price - entry) / risk;
  const out = { holdComplete: complete, holdDays: after.length, holdCloseR: [], holdHighR: [], holdLowR: [], holdGapR: [] };
  let prevClose = day0 ? day0.c : null;
  for (const b of after) {
    out.holdCloseR.push(Number(R(b.c).toFixed(3)));
    out.holdHighR.push(Number(R(b.h).toFixed(3)));
    out.holdLowR.push(Number(R(b.l).toFixed(3)));
    out.holdGapR.push(prevClose ? Number(((b.o - prevClose) / risk).toFixed(3)) : null);
    prevClose = b.c;
  }
  if (rec.status === "resolved" && (rec.result === "stop" || rec.result === "target")) {
    return { ...out, holdResultR: rec.resultR, holdExitDay: 0, holdReason: rec.result };
  }
  for (let k = 0; k < after.length; k += 1) {
    const b = after[k];
    if (b.o <= stop) return { ...out, holdResultR: R(b.o), holdExitDay: k + 1, holdReason: "gap_stop" };
    if (b.l <= stop) return { ...out, holdResultR: -1, holdExitDay: k + 1, holdReason: "stop" };
    if (target !== null && b.h >= target) return { ...out, holdResultR: R(target), holdExitDay: k + 1, holdReason: "target" };
  }
  if (!after.length) return { ...out, holdResultR: null, holdExitDay: null, holdReason: "no_data" }; // old enough and no daily bars at all
  return { ...out, holdResultR: R(after.at(-1).c), holdExitDay: after.length, holdReason: complete ? "day5" : "partial" };
}

const yield_ = () => new Promise((resolve) => setImmediate(resolve));

// One run: finds shadow records that still lack the multi-day fields, fetches the daily bars once, writes each record once.
async function update(now = Date.now(), { fetchBars } = {}) {
  const today = nyDate(now);
  const session = calendar.sessionFor(now);
  const afterClose = session.tradingDay && now >= session.close + POST_CLOSE_DELAY_MS;
  const pending = [];
  for (const id of store.listIds(KIND)) {
    const date = id.slice(0, 10);
    if (date >= today && !(date === today && afterClose)) continue;
    const rec = store.get(KIND, id);
    if (!rec || rec.holdComplete !== undefined || rec.status === "open") continue;
    pending.push({ id, rec });
    if (pending.length >= MAX_PER_RUN) break;
  }
  if (!pending.length) return { written: 0, pending: 0 };
  const symbols = [...new Set(pending.map((p) => p.rec.symbol))];
  const start = pending.map((p) => p.rec.date).sort()[0];
  const fetch = fetchBars || (async (syms) => {
    const res = await alpaca.getBarsDetailed({ symbols: syms, timeframe: "1Day", start, end: new Date(now - 16 * 60000).toISOString(), feed: "sip", adjustment: "split", now });
    const map = new Map();
    for (const [sym, bars] of res.bars) map.set(sym, bars.map((b) => ({ date: nyDate(Date.parse(b.t)), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c) })));
    return map;
  });
  const bySymbol = await fetch(symbols);
  let written = 0;
  for (const { id, rec } of pending) {
    const bars = (bySymbol.get(rec.symbol) || []).filter((b) => b.date < today || (afterClose && b.date === today));
    const sim = simulate(rec, bars, today);
    if (!sim) continue;
    const fresh = store.get(KIND, id); // re-read right before writing: nothing else may be overwritten
    if (!fresh || fresh.holdComplete !== undefined) continue;
    store.put(KIND, id, { ...fresh, ...sim });
    written += 1;
    if (written % 25 === 0) await yield_(); // let the event loop breathe between batches of fsyncs
  }
  return { written, pending: pending.length };
}

// Called from the engine tick. Runs at most once per day and phase (before the close / after the close); never throws, never awaited.
let lastPhase = null;
function maybeRun(now = Date.now()) {
  if (process.env.ALPACA_TRADER_HOLD === "off") return;
  const session = calendar.sessionFor(now);
  const phase = `${nyDate(now)}:${session.tradingDay && now >= session.close + POST_CLOSE_DELAY_MS ? "after" : "before"}`;
  if (lastPhase === phase) return;
  lastPhase = phase;
  update(now).catch((error) => {
    lastPhase = null; // retry on a later tick
    console.warn(`[alpaca-trader] multi-day shadow follow-up failed: ${error.message}`);
  });
}

function reset() { lastPhase = null; }

module.exports = { simulate, update, maybeRun, reset, HOLD_DAYS };

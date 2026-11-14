// "Shadow" labelling of every signal the Alpaca scanner finds, whether or not it was bought. The real account only produces a
// handful of trades a day, far too few to learn from; every signal, though, can be followed on the 5-minute candles that the
// scan already downloads: would the stop or the target (the plan's 2R) have been hit first, and how far did the price go in
// each direction (MFE/MAE, in multiples of the risk)? The features known at signal time are stored with each record so that
// conditions that work (or do not) can be analysed later. Read-only with respect to trading: nothing here places an order.
const store = require("../autopilot/store");
const { nyDate, nyTimestamp } = require("../autopilot/market");
const calendar = require("./session");

const KIND = "alpacaTrader:shadow";
const K_DAILY = "alpacaTrader:shadowDaily"; // date -> per-strategy aggregates of the signals resolved that day
const BAR_MS = 300000;
// Kept long enough for the statistical protocol (15-20+ trading days, then more). Override with ALPACA_SHADOW_KEEP_DAYS.
const KEEP_DAYS = Number(process.env.ALPACA_SHADOW_KEEP_DAYS || 120);
const CHECKPOINTS = [30, 60, 120]; // minutes after the entry candle: the R reached at that time

// Open records of the current day by symbol, so the scan does not list the whole table for every stock.
let openIndex = { date: null, bySymbol: new Map() };
let lastPrunedDate = null;

// Day-long price path of every signal, kept IN MEMORY while the day runs and written to the record ONCE at the end of the day
// (a write per scan would add fsyncs to the single SQLite writer). It keeps following the price after the stop or the target
// was hit, so that a wider stop / different target can be replayed later. A restart mid-day loses the path of that day only.
const tails = new Map(); // id -> { date, symbol, entry, risk, entryAtMs, processedUntil, pathR: [], dayMfeR, dayMaeR, closeR, nextOpenR }
const tailsBySymbol = new Map(); // symbol -> Set of ids

const finite = (v) => Number.isFinite(Number(v));

function loadIndex(date) {
  if (openIndex.date === date) return openIndex;
  const bySymbol = new Map();
  for (const id of store.listIds(KIND)) {
    if (!id.startsWith(`${date}:`)) continue;
    const rec = store.get(KIND, id);
    if (rec?.status === "open") (bySymbol.get(rec.symbol) || bySymbol.set(rec.symbol, new Set()).get(rec.symbol)).add(id);
  }
  openIndex = { date, bySymbol };
  return openIndex;
}

function resetIndex() {
  openIndex = { date: null, bySymbol: new Map() };
  lastPrunedDate = null;
  doneDates.clear();
}

// First signal per stock, strategy and day. features come from the scan: daily indicators, relative volume, session timing.
function recordSignal({ plan, symbol, daily = {}, rvol = null, session, now, fundLike = false, universeRank = null, plansThisBar = null }) {
  const date = nyDate(now);
  const id = `${date}:${symbol}:${plan.strategy}`;
  if (store.get(KIND, id)) return false;
  const entry = Number(plan.entry);
  const stop = Number(plan.stop);
  const target = Number(plan.target);
  if (!(entry > 0) || !(stop > 0) || !(entry > stop)) return false;
  const risk = entry - stop;
  const barStart = Date.parse(plan.barAt);
  const entryAtMs = (Number.isFinite(barStart) ? barStart : now) + BAR_MS; // the signal candle closes here: the notional entry
  const minutesSinceOpen = session?.open ? Math.round((entryAtMs - session.open) / 60000) : null;
  const rec = {
    id, date, symbol, strategy: plan.strategy, barAt: plan.barAt || null, firstSeenAt: new Date(now).toISOString(),
    entryAt: new Date(entryAtMs).toISOString(), entry, stop, target: target > entry ? target : null, risk,
    status: "open", mfeR: 0, maeR: 0, lastPrice: entry, processedUntil: entryAtMs,
    features: {
      rvol: finite(rvol) ? Number(rvol) : null,
      riskPct: (risk / entry) * 100,
      targetR: target > entry ? (target - entry) / risk : null,
      atrPct: finite(daily.atr14) && finite(daily.price) && daily.price > 0 ? (daily.atr14 / daily.price) * 100 : null,
      gapPct: finite(daily.gapPct) ? Number(daily.gapPct) : null,
      adv20: finite(daily.avgDollarVolume20d) ? Number(daily.avgDollarVolume20d) : null,
      minutesSinceOpen,
      fundLike: Boolean(fundLike),
      universeRank: finite(universeRank) ? Number(universeRank) : null, // position in the day's ranked universe
      plansThisBar: finite(plansThisBar) ? Number(plansThisBar) : null, // strategies that matched this stock on the same bar
      hourNy: Number(new Date(entryAtMs).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24,
      aboveMa20: finite(daily.ma20) && finite(daily.price) ? daily.price > daily.ma20 : null,
      ma20AboveMa50: finite(daily.ma20) && finite(daily.ma50) ? daily.ma20 > daily.ma50 : null,
    },
  };
  store.put(KIND, id, rec);
  tails.set(id, { date, symbol, entry, risk, entryAtMs, processedUntil: entryAtMs, pathR: [], dayMfeR: 0, dayMaeR: 0, closeR: null, nextOpenR: null });
  (tailsBySymbol.get(symbol) || tailsBySymbol.set(symbol, new Set()).get(symbol)).add(id);
  const index = loadIndex(date);
  (index.bySymbol.get(symbol) || index.bySymbol.set(symbol, new Set()).get(symbol)).add(id);
  return true;
}

function bump(date, rec) {
  const day = store.get(K_DAILY, date) || { date, byStrategy: {} };
  const row = (day.byStrategy[rec.strategy] ||= { resolved: 0, target: 0, stop: 0, eod: 0, sumR: 0, sumMfeR: 0, sumMaeR: 0 });
  row.resolved += 1;
  row[rec.result] += 1;
  row.sumR += rec.resultR;
  row.sumMfeR += rec.mfeR;
  row.sumMaeR += rec.maeR;
  store.put(K_DAILY, date, day);
}

function resolve(rec, result, resultR) {
  rec.status = "resolved";
  rec.result = result;
  rec.resultR = resultR;
  bump(rec.date, rec);
}

function followTails(symbol, closed) {
  for (const id of tailsBySymbol.get(symbol) || []) {
    const tail = tails.get(id);
    if (!tail) continue;
    for (const bar of closed) {
      const start = Date.parse(bar.t);
      if (start < tail.processedUntil) continue;
      if (tail.nextOpenR === null) tail.nextOpenR = (Number(bar.o) - tail.entry) / tail.risk; // a realistic entry: the next candle's open
      tail.dayMfeR = Math.max(tail.dayMfeR, (Number(bar.h) - tail.entry) / tail.risk);
      tail.dayMaeR = Math.max(tail.dayMaeR, (tail.entry - Number(bar.l)) / tail.risk);
      tail.closeR = (Number(bar.c) - tail.entry) / tail.risk;
      tail.pathR.push(Number(tail.closeR.toFixed(2)));
      tail.processedUntil = start + BAR_MS;
    }
  }
}

// Write the day-long path of finished days (or of today, after the close) onto the records, once.
function flushTails(today, afterClose) {
  let written = 0;
  for (const [id, tail] of [...tails]) {
    if (!(tail.date < today || (tail.date === today && afterClose))) continue;
    const rec = store.get(KIND, id);
    if (rec) {
      rec.dayMfeR = tail.dayMfeR;
      rec.dayMaeR = tail.dayMaeR;
      rec.dayCloseR = tail.closeR;
      rec.nextOpenR = tail.nextOpenR;
      rec.pathR = tail.pathR;
      store.put(KIND, id, rec);
      written += 1;
    }
    tails.delete(id);
    tailsBySymbol.get(tail.symbol)?.delete(id);
  }
  return written;
}

// Offering/dilution headline tag (news.js), written asynchronously after the signal was recorded.
function annotateNews(id, info) {
  const rec = store.get(KIND, id);
  if (!rec) return;
  rec.newsCount = info.newsCount;
  rec.newsOffering = info.newsOffering;
  rec.newsHeadline = info.newsHeadline;
  store.put(KIND, id, rec);
}

// What the engine decided about this stock's signals (bought or why not), written by entry.js: not reconstructable later.
function annotate(symbol, strategies, now, info) {
  const date = nyDate(now);
  for (const strategy of strategies || []) {
    const id = `${date}:${symbol}:${strategy}`;
    const rec = store.get(KIND, id);
    if (!rec) continue;
    rec.decisionOutcome = info.outcome || null;
    rec.decisionReason = info.reason || null;
    rec.decisionScore = finite(info.score) ? Number(info.score) : null;
    rec.decidedAt = new Date(now).toISOString();
    store.put(KIND, id, rec);
  }
}

// Feed the closed 5-minute candles of one stock. `now` is the scan time; only candles closed by then are used.
function update(symbol, bars, now) {
  const date = nyDate(now);
  const closed = (bars || [])
    .filter((b) => Date.parse(b.t) + BAR_MS <= now && [b.o, b.h, b.l, b.c].every((v) => Number.isFinite(Number(v))))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  followTails(symbol, closed);
  const ids = loadIndex(date).bySymbol.get(symbol);
  if (!ids?.size) return 0;
  let changed = 0;
  for (const id of [...ids]) {
    const rec = store.get(KIND, id);
    if (!rec || rec.status !== "open") {
      ids.delete(id);
      continue;
    }
    let touched = false;
    for (const bar of closed) {
      const start = Date.parse(bar.t);
      if (start < rec.processedUntil) continue;
      touched = true;
      rec.mfeR = Math.max(rec.mfeR, (Number(bar.h) - rec.entry) / rec.risk);
      rec.maeR = Math.max(rec.maeR, (rec.entry - Number(bar.l)) / rec.risk);
      rec.lastPrice = Number(bar.c);
      rec.processedUntil = start + BAR_MS;
      const minutes = (start + BAR_MS - Date.parse(rec.entryAt)) / 60000;
      for (const m of CHECKPOINTS) if (rec[`r${m}`] === undefined && minutes >= m) rec[`r${m}`] = (Number(bar.c) - rec.entry) / rec.risk;
      const hitStop = Number(bar.l) <= rec.stop;
      const hitTarget = rec.target !== null && Number(bar.h) >= rec.target;
      // Both inside one candle: the order is unknown, so count it as the stop (the pessimistic reading).
      if (hitStop) resolve(rec, "stop", -1);
      else if (hitTarget) resolve(rec, "target", (rec.target - rec.entry) / rec.risk);
      if (rec.status === "resolved") break;
    }
    if (touched) {
      store.put(KIND, id, rec);
      changed += 1;
    }
    if (rec.status === "resolved") ids.delete(id);
  }
  return changed;
}

// After the close (or on a later day, e.g. after a restart) every still-open signal ends at its last seen price. Each day is
// finalised once per process: later calls only look at the dates they have not handled yet.
const doneDates = new Set();

function finalizeStale(now) {
  const today = nyDate(now);
  const day = calendar.sessionFor(now);
  const afterClose = now >= (day.tradingDay ? day.close : nyTimestamp(today, "16:00"));
  let finalized = 0;
  const finish = (id) => {
    const rec = store.get(KIND, id);
    if (rec?.status === "open") {
      resolve(rec, "eod", (rec.lastPrice - rec.entry) / rec.risk);
      store.put(KIND, id, rec);
      finalized += 1;
    }
  };
  const ids = store.listIds(KIND);
  for (const date of new Set(ids.map((id) => id.slice(0, 10)))) {
    if (date >= today || doneDates.has(date)) continue;
    for (const id of ids) if (id.startsWith(`${date}:`)) finish(id);
    doneDates.add(date);
  }
  flushTails(today, afterClose);
  if (afterClose && !doneDates.has(today)) {
    const index = loadIndex(today);
    for (const symbolIds of index.bySymbol.values()) {
      for (const id of symbolIds) finish(id);
      symbolIds.clear();
    }
    doneDates.add(today);
  }
  if (lastPrunedDate !== today) {
    prune(now);
    lastPrunedDate = today;
  }
  return finalized;
}

function prune(now) {
  const cutoff = nyDate(now - KEEP_DAYS * 86400000);
  for (const id of store.listIds(KIND)) if (id.slice(0, 10) < cutoff) store.remove(KIND, id);
  for (const date of store.listIds(K_DAILY)) if (date < cutoff) store.remove(K_DAILY, date);
}

// Per-strategy totals over the last `days` days, from the daily aggregates, plus today's still-open signals.
function summary(now = Date.now(), days = 30) {
  const since = nyDate(now - days * 86400000);
  const totals = {};
  for (const date of store.listIds(K_DAILY)) {
    if (date < since) continue;
    const day = store.get(K_DAILY, date);
    for (const [strategy, row] of Object.entries(day?.byStrategy || {})) {
      const t = (totals[strategy] ||= { resolved: 0, target: 0, stop: 0, eod: 0, sumR: 0, sumMfeR: 0, sumMaeR: 0 });
      for (const key of Object.keys(t)) t[key] += row[key] || 0;
    }
  }
  const rows = Object.entries(totals)
    .map(([strategy, t]) => ({
      strategy, resolved: t.resolved, target: t.target, stop: t.stop, eod: t.eod,
      targetFirstPct: t.target + t.stop ? (t.target / (t.target + t.stop)) * 100 : null,
      avgR: t.resolved ? t.sumR / t.resolved : null, avgMfeR: t.resolved ? t.sumMfeR / t.resolved : null, avgMaeR: t.resolved ? t.sumMaeR / t.resolved : null,
    }))
    .sort((a, b) => b.resolved - a.resolved);
  const index = loadIndex(nyDate(now));
  let openToday = 0;
  for (const ids of index.bySymbol.values()) openToday += ids.size;
  return { days, rows, openToday, totalResolved: rows.reduce((sum, r) => sum + r.resolved, 0) };
}

const CSV_COLUMNS = ["date", "symbol", "strategy", "status", "result", "resultR", "mfeR", "maeR", "r30", "r60", "r120", "entry", "stop", "target", "riskPct", "targetR", "rvol", "atrPct", "gapPct", "adv20", "minutesSinceOpen", "hourNy", "aboveMa20", "ma20AboveMa50", "fundLike", "universeRank", "plansThisBar", "decisionOutcome", "decisionReason", "decisionScore", "decidedAt", "dayMfeR", "dayMaeR", "dayCloseR", "nextOpenR", "newsCount", "newsOffering", "newsHeadline", "pathR"];

function toCsv(now = Date.now(), days = 60) {
  const since = nyDate(now - days * 86400000);
  const rows = [CSV_COLUMNS.join(",")];
  for (const id of store.listIds(KIND).sort()) {
    if (id.slice(0, 10) < since) continue;
    const rec = store.get(KIND, id);
    if (!rec) continue;
    const flat = { ...rec, ...rec.features };
    rows.push(CSV_COLUMNS.map((c) => (flat[c] === undefined || flat[c] === null ? "" : Array.isArray(flat[c]) ? flat[c].join(" ") : typeof flat[c] === "number" ? Number(flat[c].toFixed(4)) : String(flat[c]))).join(","));
  }
  return rows.join("\n");
}

module.exports = { recordSignal, annotate, annotateNews, update, finalizeStale, summary, toCsv, resetIndex };

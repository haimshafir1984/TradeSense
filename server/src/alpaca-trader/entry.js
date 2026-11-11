const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");
const catalystCache = require("../execution/catalystCache");
// Pure scoring/sizing math only (no I/O, no MT4 state). Shared read-only with the Colmex side so the
// two arms score signals the same way; nothing here calls observe/flush/view from that module.
const shared = require("../execution/entryDecision");

const KIND = "alpacaTrader";
const MAX_LOG = 300;

// store.js keys by a single "kind" string; namespace it ourselves so box/log never collide with any
// kind used elsewhere (including the Colmex side's own "entryBox"/"entryDecision").
const K_BOX = `${KIND}:box`;
const K_LOG = `${KIND}:log`;
const K_META = `${KIND}:tradeMeta`; // orderId -> what was decided at entry (kept; the 300-entry log is pruned)

function boxId(symbol, now) {
  return `${nyDate(now)}:${symbol}`;
}

function getBox(symbol, now) {
  return store.get(K_BOX, boxId(symbol, now));
}
function putBox(symbol, now, value) {
  return store.put(K_BOX, boxId(symbol, now), value);
}

function record(entry, now) {
  const id = `${new Date(now).toISOString()}:${entry.symbol}`;
  store.put(K_LOG, id, { id, at: new Date(now).toISOString(), ...entry });
  const ids = store.listIds(K_LOG).sort();
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_LOG))) store.remove(K_LOG, old);
  return id;
}

function activeSignals(box, now) {
  return box.signals.filter((s) => Date.parse(s.signal.expiresAt || now) > now);
}

// Called once per matched strategy per symbol per scan tick.
function observe({ signal, now = Date.now() }) {
  const id = boxId(signal.ticker, now);
  const box = getBox(signal.ticker, now);
  const entry = { id: signal.id, strategy: signal.strategy, at: new Date(now).toISOString(), signal };
  if (box?.state === "entered") return { state: "locked" };
  if (box && box.state === "open") {
    if (!box.signals.some((s) => s.id === signal.id)) box.signals.push(entry);
    putBox(signal.ticker, now, box);
    return { state: "open" };
  }
  putBox(signal.ticker, now, { id, symbol: signal.ticker, state: "open", openedAt: new Date(now).toISOString(), signals: [entry] });
  try { catalystCache.prefetch(signal.ticker, now).catch(() => {}); } catch {}
  return { state: "open" };
}

// Decides every open box. place(symbol, shares, signal) must place the order and return {orderId} or throw.
async function flush({ profile, equity, exposure, enabled, place, now = Date.now() }) {
  const results = [];
  const today = nyDate(now);
  // The caller measures exposure once per scan, before any of this scan's orders exist. Every box decided in the same
  // pass used to be sized against that same number, so six simultaneous entries could each take up to half of the
  // account (2026-11-10: six ~$30k positions on a $100k account, then a -7% day). Track what this pass already placed.
  let runningExposure = Number(exposure) || 0;
  for (const id of store.listIds(K_BOX)) {
    if (!id.startsWith(`${today}:`)) continue;
    const box = store.get(K_BOX, id);
    if (!box || box.state !== "open") continue;
    const live = activeSignals(box, now);
    const ageMin = (now - Date.parse(box.openedAt)) / 60000;
    const windowOver = ageMin >= profile.windowMin;
    const names = [...new Set(box.signals.map((s) => s.strategy))];
    const skip = (reason, reasonText, extra = {}) => {
      record({ symbol: box.symbol, outcome: "skipped", reason, reasonText, strategies: names, ...extra }, now);
      putBox(box.symbol, now, { ...box, state: "skipped", reason, closedAt: new Date(now).toISOString() });
      results.push({ symbol: box.symbol, outcome: "skipped", reason });
    };
    if (!enabled) { skip("disabled", "המסחר בחשבון Alpaca כבוי"); continue; }
    if (!live.length) { skip("signals_expired", "כל האיתותים פגו לפני החלטה"); continue; }
    const sc = shared.score(live.map((s) => s.signal), profile, catalystCache.get(box.symbol, now));
    const ready = sc.score >= profile.immediateScore || windowOver;
    if (!ready) continue;
    if (sc.score < profile.minScore) { skip("score_low", `ציון ${sc.score} נמוך מהמינימום ${profile.minScore}`, { score: sc.score }); continue; }
    const lead = live[live.length - 1].signal;
    const price = Number(lead.entry);
    const stop = Number(lead.stop);
    if (!Number.isFinite(price) || !Number.isFinite(stop) || price <= 0) { skip("invalid_plan", "מחיר/סטופ לא תקינים"); continue; }
    const sizing = shared.size({ score: sc.score, price, stop, equity, exposure: runningExposure, profile });
    const base = { score: sc.score, families: sc.families, sizing, price };
    if (sizing.shares < profile.minShares) {
      skip("size_too_small", `הכמות שיצאה (${sizing.shares}) נמוכה מהמינימום ${profile.minShares}`, base);
      continue;
    }
    try {
      const placed = await place(box.symbol, sizing.shares, lead);
      runningExposure += price * sizing.shares;
      putBox(box.symbol, now, { ...box, state: "entered", orderId: placed?.orderId || null, closedAt: new Date(now).toISOString() });
      record({ symbol: box.symbol, outcome: "entered", reason: "entered", reasonText: `${sc.families.length} משפחות מסכימות, ציון ${sc.score}, ${sizing.shares} מניות`, strategies: names, orderId: placed?.orderId || null, ...base }, now);
      try {
        // Durable record for the trade report (trades.js). A failure here must never affect the order that was just placed.
        store.put(K_META, placed?.orderId || `${new Date(now).toISOString()}:${box.symbol}`, {
          orderId: placed?.orderId || null, symbol: box.symbol, at: new Date(now).toISOString(), strategies: names,
          lead: lead.strategy || names[0] || null, score: sc.score, plannedPrice: price, shares: sizing.shares, stop, target: Number(lead.target) || null,
        });
      } catch {
        // metadata is best-effort
      }
      require("./notify").entered({ symbol: box.symbol, shares: sizing.shares, price, equity, stop, target: Number(lead.target) || null, score: sc.score, strategies: names, orderId: placed?.orderId, now });
      results.push({ symbol: box.symbol, outcome: "entered", shares: sizing.shares, score: sc.score, stop, target: Number(lead.target) || null });
    } catch (error) {
      const transient = ["account_unavailable", "not_configured"].includes(error.code);
      if (transient && !windowOver) continue;
      skip(error.code || "place_failed", error.message, base);
    }
  }
  return results;
}

function recentLog(limit = 100) {
  return store.list(K_LOG).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}

function todayBoxes(now = Date.now()) {
  const today = nyDate(now);
  return store.listIds(K_BOX).filter((id) => id.startsWith(`${today}:`)).map((id) => store.get(K_BOX, id));
}

function tradeMeta() {
  return store.list(K_META);
}

// Entered decisions still present in the (pruned) log since a time; a fallback match for trades older than the metadata record.
function enteredSince(sinceMs) {
  return store.list(K_LOG).filter((d) => d.outcome === "entered" && Date.parse(d.at) >= sinceMs);
}

module.exports = { observe, flush, recentLog, todayBoxes, tradeMeta, enteredSince };

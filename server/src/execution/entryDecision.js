const store = require("../autopilot/store");
const { nyDate } = require("../autopilot/market");
const positions = require("./positions");
const entryProfile = require("./entryProfile");
const risk = require("./risk");
const bridge = require("./bridge");

// Entry decision layer. Signals do not become orders directly: each symbol gets a "box" that collects
// the signals of different strategies for a few minutes, a score is computed, and only then (if the
// score is sufficient) one order is created, sized from the real MT4 equity. One symbol, one entry per day.
const BOX = "entryBox";
const LOG = "entryDecision";
const MAX_LOG = 200;

// Strategies that look at the same thing count once. Agreement across families is what raises the score.
const FAMILIES = {
  orb15: "orb",
  orb15_retest: "orb",
  vwap_reclaim: "vwap",
  vwap_pullback: "vwap",
  gap_pullback: "gap",
  momentum_bull_flag: "momentum",
  reversal5: "reversal",
  pullback2_v1: "pullback",
  breakout20_v1: "breakout",
};

function familyOf(strategy) {
  return FAMILIES[strategy] || strategy;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Quality points of one signal (volume, liquidity, stop distance), before the user's cap.
function quality(signal) {
  let pts = 0;
  const notes = [];
  const rvol = Number(signal.rvol);
  if (Number.isFinite(rvol)) {
    const p = rvol >= 3 ? 4 : rvol >= 2 ? 3 : rvol >= 1.5 ? 2 : 0;
    if (p) notes.push(`נפח יחסי ${rvol.toFixed(1)} (+${p})`);
    pts += p;
  }
  const adv = Number(signal.daily?.avgDollarVolume20d);
  if (Number.isFinite(adv)) {
    const p = adv >= 50e6 ? 3 : adv >= 20e6 ? 2 : adv >= 5e6 ? 1 : 0;
    if (p) notes.push(`נזילות גבוהה (+${p})`);
    pts += p;
  }
  const atr = Number(signal.daily?.atr14);
  const dist = Number(signal.entry) - Number(signal.stop);
  if (Number.isFinite(atr) && atr > 0 && Number.isFinite(dist) && dist > 0) {
    const ratio = dist / atr;
    const p = ratio >= 0.3 && ratio <= 1.5 ? 3 : ratio > 2.5 ? -3 : 0;
    if (p) notes.push(`${p > 0 ? "סטופ סביר" : "סטופ רחוק"} ביחס לתנודתיות (${p > 0 ? "+" : ""}${p})`);
    pts += p;
  }
  return { pts, notes };
}

function score(signals, profile, catalyst = null) {
  const families = [...new Set(signals.map((s) => familyOf(s.strategy)))];
  const base = profile.familyPoints[clamp(families.length, 1, 4) - 1];
  let best = { pts: -Infinity, notes: [] };
  for (const s of signals) {
    const q = quality(s);
    if (q.pts > best.pts) best = q;
  }
  const bonus = clamp(best.pts === -Infinity ? 0 : best.pts, -profile.qualityMax, profile.qualityMax);
  const cat = require("./catalystCache").points(catalyst, profile.catalystMax ?? 8);
  const notes = cat.note ? [...best.notes, cat.note] : best.notes;
  return { score: clamp(Math.round(base + bonus + cat.pts), 0, 100), families, base, bonus, catalyst: cat.pts, notes };
}

// Shares from budget: a share of equity that grows with the score, capped by the risk at the stop and
// by the room left under the total exposure limit. Rounded down; null when below the broker minimum.
function size({ score: sc, price, stop, equity, exposure, profile }) {
  const span = Math.max(1, 100 - profile.minScore);
  const t = clamp((sc - profile.minScore) / span, 0, 1);
  const pct = profile.perTradeMinPct + (profile.perTradeMaxPct - profile.perTradeMinPct) * t;
  const budget = (equity * pct) / 100;
  const byBudget = Math.floor(budget / price);
  const dist = price - stop;
  const byRisk = dist > 0 ? Math.floor((equity * profile.maxRiskPct) / 100 / dist) : 0;
  const room = (equity * profile.totalExposurePct) / 100 - exposure;
  const byRoom = Math.floor(room / price);
  const shares = Math.max(0, Math.min(byBudget, byRisk, byRoom));
  const limitedBy = shares === byRoom && byRoom < Math.min(byBudget, byRisk) ? "exposure" : shares === byRisk && byRisk < byBudget ? "risk" : "budget";
  return { shares, pct: Math.round(pct * 100) / 100, budget: Math.round(budget), byBudget, byRisk, byRoom, limitedBy };
}

function boxId(userId, symbol, now) {
  return `${nyDate(now)}:${symbol}`;
}

function exposureNow(userId, snapshot) {
  let total = 0;
  for (const p of snapshot.positions || []) total += Math.abs(p.lots) * (Number.isFinite(p.currentPrice) ? p.currentPrice : p.openPrice);
  for (const o of store.listUser(userId, "executionOrder"))
    if (["pending", "claimed", "submitted", "partially_filled", "unknown"].includes(o.status))
      total += Math.abs(o.quantity) * (Number(o.limitPrice) || 0);
  return total;
}

function logDecision(userId, entry, now) {
  const id = `${new Date(now).toISOString()}:${entry.symbol}`;
  store.putUser(userId, LOG, id, { id, at: new Date(now).toISOString(), ...entry });
  try {
    const notices = require("../autopilot/notifications");
    const entered = entry.outcome === "entered";
    notices.event(
      userId,
      `entry:${id}`,
      `${entry.symbol} · ${entered ? "נכנסנו לעסקה" : "לא נכנסנו"}`,
      entry.reasonText || entry.reason || "",
      entered ? "signal" : "info",
    );
  } catch {}
  const ids = store.listUser(userId, LOG).map((e) => e.id).sort();
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_LOG))) store.removeUser(userId, LOG, old);
}

function closeBox(userId, box, patch, now) {
  store.putUser(userId, BOX, box.id, { ...box, ...patch, closedAt: new Date(now).toISOString() });
}

// Called when the engine creates a signal. Never throws; the signal is only recorded.
function observe({ userId, signal, brokerSymbol, now = Date.now() }) {
  const id = boxId(userId, signal.ticker, now);
  const box = store.getUser(userId, BOX, id);
  if (!brokerSymbol) {
    // The broker does not trade this stock: say so once per day instead of queueing an order that can never run.
    if (!box) {
      logDecision(userId, { symbol: signal.ticker, outcome: "skipped", reason: "not_at_broker", reasonText: "המניה לא נסחרת אצל הברוקר (אין סימול ב-MT4)", strategies: [signal.strategy] }, now);
      store.putUser(userId, BOX, id, { id, userId, symbol: signal.ticker, brokerSymbol: null, state: "skipped", reason: "not_at_broker", openedAt: new Date(now).toISOString(), closedAt: new Date(now).toISOString(), signals: [] });
    }
    return { state: "unmapped" };
  }
  const entry = { id: signal.id, strategy: signal.strategy, at: new Date(now).toISOString(), signal: { ...signal, brokerSymbol } };
  if (box?.state === "entered") {
    logDecision(userId, { symbol: signal.ticker, outcome: "ignored", reason: "symbol_locked", reasonText: "כבר נכנסנו למניה הזו היום", strategies: [signal.strategy] }, now);
    return { state: "locked" };
  }
  if (box && box.state === "open") {
    if (!box.signals.some((s) => s.id === signal.id)) box.signals.push(entry);
    store.putUser(userId, BOX, id, box);
    return { state: "open" };
  }
  // A new box starts if none exists, or the previous one ended without an entry.
  store.putUser(userId, BOX, id, { id, userId, symbol: signal.ticker, brokerSymbol, state: "open", openedAt: new Date(now).toISOString(), signals: [entry] });
  try { if (process.env.SENTIMENT_COLLECT !== "false") require("../autopilot/sentimentLog").collect(signal.ticker, { now }).catch(() => {}); } catch {}
  try { require("./catalystCache").prefetch(signal.ticker, now).catch(() => {}); } catch {}
  return { state: "open" };
}

function activeSignals(box, now) {
  return box.signals.filter((s) => Date.parse(s.signal.expiresAt || 0) > now);
}

// Decides every open box of this user. Called from the engine tick and right after a signal is recorded.
function flush({ userId, brokerAccountId, enabled = true, now = Date.now() }) {
  const results = [];
  const profile = entryProfile.read();
  for (const box of store.listUser(userId, BOX).filter((b) => b.state === "open")) {
    const live = activeSignals(box, now);
    const ageMin = (now - Date.parse(box.openedAt)) / 60000;
    const windowOver = ageMin >= profile.windowMin;
    const names = [...new Set(box.signals.map((s) => s.strategy))];
    const skip = (reason, reasonText, extra = {}) => {
      logDecision(userId, { symbol: box.symbol, outcome: "skipped", reason, reasonText, strategies: names, ...extra }, now);
      closeBox(userId, box, { state: "skipped", reason }, now);
      results.push({ symbol: box.symbol, outcome: "skipped", reason });
    };
    if (!enabled) { skip("autonomy_off", "המסחר העצמאי כבוי"); continue; }
    if (!live.length) { skip("signals_expired", "כל האיתותים פגו לפני החלטה"); continue; }
    const sc = score(live.map((s) => s.signal), profile, require("./catalystCache").get(box.symbol, now));
    const ready = sc.score >= profile.immediateScore || windowOver;
    if (!ready) continue;
    if (sc.score < profile.minScore) { skip("score_low", `ציון ${sc.score} נמוך מהמינימום ${profile.minScore}`, { score: sc.score, families: sc.families }); continue; }
    // The freshest live signal supplies price and stop.
    const lead = live[live.length - 1].signal;
    const snapshot = positions.current(now);
    if (!snapshot.fresh || snapshot.isDemo !== true || !Number.isFinite(snapshot.equity)) {
      if (windowOver && ageMin >= profile.windowMin + 3) skip("mt4_unknown", "אין דיווח עדכני מ־MT4", { score: sc.score, families: sc.families });
      continue;
    }
    const price = Number(lead.entry);
    const stopped = risk.applyStopPolicy({ ...lead });
    const sizing = size({ score: sc.score, price, stop: Number(stopped.stop), equity: snapshot.equity, exposure: exposureNow(userId, snapshot), profile });
    const base = { score: sc.score, families: sc.families, scoreNotes: sc.notes, sizing, price };
    if (sizing.shares < profile.minShares) {
      skip("size_too_small", `הכמות שיצאה (${sizing.shares}) נמוכה מהמינימום ${profile.minShares} (מוגבל לפי ${sizing.limitedBy === "exposure" ? "חשיפה כוללת" : sizing.limitedBy === "risk" ? "סיכון לעסקה" : "תקציב"})`, base);
      continue;
    }
    try {
      const mapped = { ...stopped, brokerSymbol: box.brokerSymbol, sizing: { ...(lead.sizing || {}), shares: sizing.shares, feasible: true, source: "entry_profile", score: sc.score } };
      risk.validateSignal({ userId, signal: mapped, brokerAccountId, symbol: box.brokerSymbol, now });
      const order = bridge.queueSignal({ userId, signal: mapped, brokerAccountId, symbol: box.brokerSymbol, now });
      logDecision(userId, { symbol: box.symbol, outcome: "entered", reason: "entered", reasonText: `${sc.families.length} משפחות מסכימות, ציון ${sc.score}, ${sizing.shares} מניות`, strategies: names, orderId: order?.id || null, ...base }, now);
      closeBox(userId, box, { state: "entered", orderId: order?.id || null }, now);
      results.push({ symbol: box.symbol, outcome: "entered", shares: sizing.shares, score: sc.score });
    } catch (error) {
      // Gate rejections that can clear within the window are retried; otherwise the box ends.
      const transient = ["mt4_unknown", "day_base_missing"].includes(error.code);
      if (transient && !windowOver) continue;
      skip(error.code || "risk_check_failed", error.message, base);
    }
  }
  return results;
}

function view(userId, now = Date.now()) {
  const profile = entryProfile.read();
  const today = nyDate(now);
  const boxes = store.listUser(userId, BOX).filter((b) => b.id.startsWith(`${today}:`)).map((b) => {
    const live = b.state === "open" ? activeSignals(b, now) : b.signals;
    const sc = live.length ? score(live.map((s) => s.signal), profile, require("./catalystCache").get(b.symbol, now)) : null;
    return { symbol: b.symbol, state: b.state, openedAt: b.openedAt, closedAt: b.closedAt || null, strategies: [...new Set(b.signals.map((s) => s.strategy))], score: sc?.score ?? null, families: sc?.families ?? [] };
  });
  const decisions = store.listUser(userId, LOG).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 50);
  return { profile, defaults: entryProfile.DEFAULTS, boxes, decisions };
}

module.exports = { FAMILIES, familyOf, quality, score, size, observe, flush, view };

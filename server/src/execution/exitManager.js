const store = require("../autopilot/store");
const positions = require("./positions");
const riskProfile = require("./riskProfile");
const commands = require("./closeRequests");
const orders = require("./orders");
const market = require("../autopilot/market");

// Automatic management of the positions TradeSense opened: daily-loss close, take-profit tiers,
// stop moves and end-of-day close. It only creates commands for the EA; a step is marked done
// only after MT4 confirmed it. A failed or unknown command is shown and never retried automatically.
const KIND = "executionPosition";
const STATUS_KEY = "execution-manager-status";
const EOD_WINDOW_BEFORE_MS = 60_000;
const EOD_WINDOW_AFTER_MS = 120_000;
const LOT_EPSILON = 1e-6;

let running = false;

function iso(now) {
  return new Date(now).toISOString();
}

function inFlight(command) {
  return command && ["pending", "claimed", "unknown"].includes(command.status);
}

function floorToStep(value, step) {
  return Math.floor(value / step + LOT_EPSILON) * step;
}

function round(value, digits = 6) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

async function defaultSession(now) {
  const rows = await market.sessions(now);
  return rows.find((row) => row.date === market.nyDate(now)) || null;
}

function loadRecords() {
  return store.list(KIND);
}

function recordFor(position, all, now, snapshot = null) {
  let record = all.find((r) => r.ticket === position.ticket);
  if (record) return record;
  // A position that appears right after a partial close whose result could not be matched must not
  // restart the take-profit logic from scratch (that could sell the same quantity twice).
  const orphanOf = snapshot && all.find((r) => r.halted && r.symbol === position.symbol && r.side === position.side && !snapshot.positions.some((p) => p.ticket === r.ticket));
  const order = orders.listAll().find((o) => o.brokerOrderId === position.ticket && ["filled", "submitted", "partially_filled"].includes(o.status));
  record = {
    id: order ? order.id : `ticket-${position.ticket}`,
    ticket: position.ticket,
    symbol: position.symbol,
    side: position.side,
    entry: Number.isFinite(order?.averagePrice) ? order.averagePrice : position.openPrice,
    originalLots: position.lots,
    soldLots: 0,
    tiers: {},
    stopApplied: false,
    stopNote: null,
    halted: orphanOf ? "נוצרה אחרי פעולה שלא אומתה במלואה; הניהול האוטומטי נעצר לפוזיציה הזו" : null,
    createdAt: iso(now),
  };
  store.put(KIND, record.id, record);
  all.push(record);
  return record;
}

function save(record) {
  store.put(KIND, record.id, record);
}

// Applies results MT4 confirmed: the new ticket after a partial close and the sold quantity.
function applyConfirmed(record, position, cmds) {
  for (const [key, tier] of Object.entries(record.tiers)) {
    if (tier.status !== "pending" || !tier.commandId) continue;
    const cmd = cmds.find((c) => c.id === tier.commandId);
    if (!cmd) continue;
    if (cmd.status === "closed") {
      tier.status = "done";
      tier.note = null;
    } else if (["rejected", "expired"].includes(cmd.status)) {
      tier.status = "failed";
      tier.note = cmd.error || (cmd.status === "expired" ? "פג תוקף הפקודה לפני שה־EA ביצע אותה" : "הפקודה נדחתה");
    } else if (cmd.status === "unknown") {
      record.halted = "מצב הביצוע לא ידוע; בדוק את הפוזיציה ב־MT4";
    }
  }
  const confirmed = cmds.filter((c) => c.type === "partial_close" && c.status === "closed" && !(record.appliedCommands || []).includes(c.id) && Object.values(record.tiers).some((t) => t.commandId === c.id));
  for (const cmd of confirmed) {
    record.appliedCommands = [...(record.appliedCommands || []), cmd.id];
    record.soldLots = round(record.soldLots + cmd.lots, 6);
    if (cmd.remainingTicket) record.ticket = cmd.remainingTicket;
    else record.halted = "לא התקבל מספר הפוזיציה שנותרה אחרי המכירה החלקית; בדוק ב־MT4";
  }
  return record;
}

function verifyQuantity(record, snapshot) {
  const current = snapshot.positions.find((p) => p.ticket === record.ticket);
  if (!current) return;
  const expected = round(record.originalLots - record.soldLots, 6);
  if (Math.abs(current.lots - expected) > 1e-4) record.halted = `הכמות ב־MT4 (${current.lots}) שונה מהמצופה (${expected}); הניהול האוטומטי נעצר לפוזיציה הזו`;
}

function priceChangePct(record, position) {
  if (!Number.isFinite(position.currentPrice) || !(record.entry > 0)) return null;
  return ((position.currentPrice - record.entry) / record.entry) * 100 * (record.side === "sell" ? -1 : 1);
}

function tierPlan(record, position, profile) {
  const gain = priceChangePct(record, position);
  if (gain == null) return null;
  const active = profile.takeProfit.tiers
    .map((tier, index) => ({ ...tier, index: index + 1 }))
    .filter((tier) => tier.triggerPct != null && tier.sellPct != null);
  const crossed = active.filter((tier) => gain >= tier.triggerPct && !record.tiers[tier.index]);
  if (!crossed.length) return null;
  const sellPct = crossed.reduce((sum, tier) => sum + tier.sellPct, 0);
  return { crossed, sellPct, gain };
}

function enqueueTier(record, position, profile, now, actions) {
  const plan = tierPlan(record, position, profile);
  if (!plan) return;
  const step = position.lotStep;
  const minLot = position.minLot;
  const keys = plan.crossed.map((t) => t.index);
  if (!(step > 0) || !(minLot > 0)) {
    record.halted = "חסר מידע על כמות מינימלית וצעד כמות מ־MT4; הניהול האוטומטי נעצר לפוזיציה הזו";
    actions.push({ type: "halt", ticket: record.ticket, note: record.halted });
    return;
  }
  const wanted = (record.originalLots * plan.sellPct) / 100;
  let lots = round(floorToStep(wanted, step), 6);
  const remaining = round(position.lots - lots, 6);
  let type = "partial_close";
  if (lots >= position.lots - LOT_EPSILON) {
    type = "close";
    lots = position.lots;
  }
  const tooSmall = lots < minLot - LOT_EPSILON;
  const leavesDust = type === "partial_close" && remaining > LOT_EPSILON && remaining < minLot - LOT_EPSILON;
  if (tooSmall || leavesDust) {
    const note = tooSmall ? "הכמות למכירה קטנה מהמינימום של הברוקר; המדרגה דולגה" : "המכירה הייתה משאירה כמות קטנה מהמינימום של הברוקר; המדרגה דולגה";
    for (const index of keys) record.tiers[index] = { status: "skipped", note, at: iso(now) };
    actions.push({ type: "tier_skipped", ticket: record.ticket, tiers: keys, note });
    return;
  }
  const dedupeKey = `tp:${record.id}:${keys.join("-")}`;
  const result = commands.enqueue({ type, ticket: record.ticket, lots, dedupeKey, reason: `tier ${keys.join("+")} at +${round(plan.gain, 2)}%`, now });
  if (result.blocked) return;
  for (const index of keys) record.tiers[index] = { status: "pending", commandId: result.request.id, at: iso(now), lots, note: null };
  actions.push({ type, ticket: record.ticket, lots, tiers: keys, commandId: result.request.id });
}

function enqueueStopMove(record, position, profile, now, actions) {
  if (record.stopApplied || profile.takeProfit.stopAfter === "keep") return;
  const anyDone = Object.values(record.tiers).some((t) => t.status === "done");
  if (!anyDone) return;
  const target = profile.takeProfit.stopAfter === "breakeven" ? record.entry : profile.takeProfit.manualStopPrice;
  const price = position.currentPrice;
  const valid = Number.isFinite(target) && Number.isFinite(price) && (record.side === "sell" ? target > price : target < price);
  if (!valid) {
    record.stopApplied = true;
    record.stopNote = "הסטופ המבוקש אינו מתאים למחיר הנוכחי, ולכן לא הוזז";
    actions.push({ type: "stop_skipped", ticket: record.ticket, note: record.stopNote });
    return;
  }
  const result = commands.enqueue({ type: "modify_stop", ticket: record.ticket, stopLoss: target, dedupeKey: `sa:${record.id}`, reason: profile.takeProfit.stopAfter, now });
  if (result.blocked) return;
  record.stopApplied = true;
  record.stopCommandId = result.request.id;
  actions.push({ type: "modify_stop", ticket: record.ticket, stopLoss: target, commandId: result.request.id });
}

function closeAll(kind, key, snapshot, all, now, actions) {
  for (const position of snapshot.positions.filter((p) => p.managed)) {
    const record = recordFor(position, all, now, snapshot);
    try {
      const result = commands.enqueue({ type: "close", ticket: position.ticket, dedupeKey: `${kind}:${key}:${record.id}`, reason: kind, now });
      if (!result.duplicate) actions.push({ type: "close", ticket: position.ticket, reason: kind, commandId: result.request.id });
    } catch (error) {
      actions.push({ type: "error", ticket: position.ticket, reason: kind, note: error.message });
    }
  }
}

function reconcileUnknown(snapshot, now) {
  for (const cmd of commands.listAll()) {
    if (cmd.status !== "unknown" || cmd.type !== "close") continue;
    if (!snapshot.positions.some((p) => p.ticket === cmd.ticket)) {
      commands.transition(cmd.id, "closed", { error: "אומת לפי דיווח הפוזיציות מ־MT4" }, now);
    }
  }
}

async function evaluate({ now = Date.now(), getSession = defaultSession } = {}) {
  if (running) return null;
  running = true;
  const status = { at: iso(now), enabled: false, actions: [], warnings: [], eod: null };
  try {
    const profile = riskProfile.read();
    const snapshot = positions.current(now);
    status.enabled = profile.autoManage;
    if (!snapshot.fresh || snapshot.isDemo !== true) {
      status.warnings.push("אין דיווח עדכני מ־MT4; הניהול האוטומטי ממתין");
      return status;
    }
    reconcileUnknown(snapshot, now);
    const all = loadRecords();
    // Positions that disappeared (closed in MT4, stop or target hit) are no longer managed.
    // A short grace period covers the moment between MT4 confirming a partial close and the next report.
    for (const record of all) {
      const cmds = commands.listAll().filter((c) => c.ticket === record.ticket || Object.values(record.tiers).some((t) => t.commandId === c.id));
      applyConfirmed(record, null, cmds);
      if (snapshot.positions.some((p) => p.ticket === record.ticket)) {
        if (record.missingSince) delete record.missingSince;
      } else if (!record.missingSince) record.missingSince = iso(now);
      else if (now - Date.parse(record.missingSince) > 45_000) {
        store.remove(KIND, record.id);
        continue;
      }
      save(record);
    }
    for (const position of snapshot.positions) {
      if (!position.managed) continue;
      if (!(position.stopLoss > 0)) status.warnings.push(`לפוזיציה ${position.symbol} (${position.ticket}) אין סטופ ב־MT4`);
    }
    const managed = snapshot.positions.filter((p) => p.managed);
    const live = loadRecords();
    for (const position of managed) {
      const record = recordFor(position, live, now, snapshot);
      const cmds = commands.listAll().filter((c) => c.ticket === record.ticket || Object.values(record.tiers).some((t) => t.commandId === c.id));
      applyConfirmed(record, position, cmds);
      verifyQuantity(record, snapshot);
      save(record);
    }
    const day = riskProfile.evaluateDay(now, profile);
    if (!profile.autoManage) return status;
    if (process.env.EXECUTION_QUEUE_ENABLED !== "true") {
      status.warnings.push("תור הביצוע כבוי בשרת; הניהול האוטומטי לא יכול לשלוח פקודות");
      return status;
    }
    const all2 = loadRecords();
    // 1. Daily loss limit reached.
    if (day.breached && day.breach?.action === "close_all") closeAll("loss", day.date, snapshot, all2, now, status.actions);
    // 2. End of trading day, one minute before the regular US close.
    if (profile.endOfDay.mode === "close") {
      try {
        const session = await getSession(now);
        if (!session) status.eod = { available: true, session: null };
        else {
          status.eod = { available: true, closeAt: iso(session.close) };
          if (now >= session.close - EOD_WINDOW_BEFORE_MS && now <= session.close + EOD_WINDOW_AFTER_MS) closeAll("eod", session.date, snapshot, all2, now, status.actions);
        }
      } catch (error) {
        status.eod = { available: false, reason: "לוח המסחר אינו זמין; אין סגירה אוטומטית בסוף היום" };
      }
    }
    // 3. Take-profit tiers and the stop move that follows them.
    for (const position of managed) {
      const record = all2.find((r) => r.ticket === position.ticket) || recordFor(position, all2, now, snapshot);
      if (record.halted) {
        status.warnings.push(`${position.symbol}: ${record.halted}`);
        continue;
      }
      if (day.breached) continue;
      try {
        enqueueStopMove(record, position, profile, now, status.actions);
        if (!Object.values(record.tiers).some((t) => t.status === "pending")) enqueueTier(record, position, profile, now, status.actions);
      } catch (error) {
        status.actions.push({ type: "error", ticket: position.ticket, note: error.message });
      }
      save(record);
    }
    return status;
  } finally {
    store.put("runtime", STATUS_KEY, status);
    running = false;
  }
}

function lastStatus() {
  return store.get("runtime", STATUS_KEY) || null;
}

function view(now = Date.now()) {
  const snapshot = positions.current(now);
  const recs = loadRecords();
  const cmds = commands.listAll();
  return {
    status: lastStatus(),
    positions: snapshot.positions.filter((p) => p.managed).map((p) => {
      const rec = recs.find((r) => r.ticket === p.ticket) || null;
      const latest = cmds.filter((c) => c.ticket === p.ticket).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
      return { ticket: p.ticket, symbol: p.symbol, tiers: rec?.tiers || {}, soldLots: rec?.soldLots || 0, originalLots: rec?.originalLots ?? p.lots, halted: rec?.halted || null, stopNote: rec?.stopNote || null, hasStop: p.stopLoss > 0, lastCommand: latest && { type: latest.type, status: latest.status, error: latest.error, reason: latest.reason, at: latest.updatedAt } };
    }),
  };
}

module.exports = { KIND, evaluate, lastStatus, view };

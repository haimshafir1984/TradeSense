const { randomUUID } = require("node:crypto");
const store = require("./store");
const config = require("./settings");
const notices = require("./notifications");
const { nyDate } = require("./market");
function positive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${label} חייב להיות מספר חיובי`);
}
function finitePositive(value, label) {
  positive(value, label);
  if (!Number.isFinite(value) || value * 1 !== value)
    throw new Error(`${label} חייב להיות מספר סופי`);
}
function requestKey(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new Error("requestId לא תקין");
    error.code = "request_invalid";
    throw error;
  }
  return value;
}
function validSignalPlan(signal, price, now) {
  return (
    Number.isFinite(signal?.stop) &&
    Number.isFinite(signal?.target) &&
    signal.stop < price &&
    price < signal.target &&
    (!signal.deadline || now < Date.parse(signal.deadline))
  );
}
function samePayload(trade, input, mode, additionalLot, signalId) {
  return trade.requestId === input.requestId &&
    trade.signalId === signalId &&
    trade.entry === input.price &&
    trade.shares === input.shares &&
    trade.enteredAt === input.executedAt &&
    trade.trackingPlanMode === mode &&
    trade.additionalLot === additionalLot;
}
function executionTime(input, earliest, now) {
  if (!input.executedAt) return now;
  const value = Date.parse(input.executedAt);
  if (!Number.isFinite(value) || value > now || value < Date.parse(earliest))
    throw new Error(
      "מועד הביצוע חייב להיות אחרי יצירת האיתות או הכניסה, ולא בעתיד",
    );
  return value;
}
function personalEntry(userId, signalId, input, now = Date.now()) {
  finitePositive(input.price, "מחיר");
  finitePositive(input.shares, "כמות");
  positive(input.price * input.shares, "סכום העסקה");
  const signal = store.getUser(userId, "signal", signalId);
  if (!signal) throw new Error("האיתות לא נמצא");
  now = executionTime(input, signal.createdAt, now);
  const requestId = requestKey(input.requestId);
  const additionalLot = input.additionalLot === true;
  const requestedMode = input.trackingPlanMode;
  if (requestedMode != null && !["signal", "none"].includes(requestedMode)) {
    const error = new Error("trackingPlanMode לא תקין");
    error.code = "request_invalid";
    throw error;
  }
  const previousRequest = requestId ? store.listUser(userId, "trade").find(t => t.requestId === requestId) : null;
  if (previousRequest) {
    const normalized = { ...input, requestId,
      executedAt: input.executedAt ? new Date(input.executedAt).toISOString() : previousRequest.enteredAt };
    if (samePayload(previousRequest, normalized, requestedMode || previousRequest.trackingPlanMode, additionalLot, signalId))
      return previousRequest;
    const error = new Error("requestId כבר שימש לדיווח אחר");
    error.code = "request_conflict";
    error.status = 409;
    throw error;
  }
  const planValid = validSignalPlan(signal, input.price, now);
  const trackingPlanMode = requestedMode || (planValid ? "signal" : "none");
  if (trackingPlanMode === "signal" && !planValid) {
    const error = new Error("תוכנית המעקב אינה מתאימה למחיר או למועד הביצוע");
    error.code = "plan_invalid";
    throw error;
  }
  // Entries are user reports of trades already executed, not order submission or authorization.
  return store.transaction(() => {
    const trades = store.listUser(userId, "trade");
    if (requestId) {
      const existing = trades.find((t) => t.requestId === requestId);
      if (existing) {
        if (samePayload(existing, { ...input, requestId, executedAt: input.executedAt || existing.enteredAt }, trackingPlanMode, additionalLot, signalId)) return existing;
        const error = new Error("requestId כבר שימש לדיווח אחר");
        error.code = "request_conflict";
        error.status = 409;
        throw error;
      }
    }
    if (!additionalLot && trades.some((t) => t.signalId === signalId && t.source === "personal" && t.status === "open")) {
      const error = new Error("כבר דיווחת על כניסה לאיתות זה; בחר דיווח על קנייה נוספת");
      error.code = "duplicate_entry";
      throw error;
    }
    const settings = config.read(userId);
    const id = randomUUID();
    return store.putUser(userId, "trade", id, {
      id,
      signalId,
      ticker: signal.ticker,
      strategy: signal.strategy,
      version: signal.version,
      source: "personal",
      status: "open",
      entry: input.price,
      shares: input.shares,
      stop: trackingPlanMode === "signal" ? signal.stop : null,
      target: trackingPlanMode === "signal" ? signal.target : null,
      deadline: trackingPlanMode === "signal" ? signal.deadline : null,
      mode: signal.mode,
      enteredAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      entryFee: 0,
      feeSource: "none",
      feeMode: "none",
      schemaVersion: 2,
      requestId,
      additionalLot,
      trackingPlanMode,
      originalRecommendation: {
        entry: signal.entry,
        shares: signal.sizing?.shares ?? null,
        stop: signal.stop,
        target: signal.target,
        deadline: signal.deadline,
        strategy: signal.strategy,
        version: signal.version,
      },
    });
  });
}
function personalClose(userId, id, input, now = Date.now()) {
  positive(input.price, "מחיר יציאה");
  return store.transaction(() => {
    const trade = store.getUser(userId, "trade", id);
    if (!trade || trade.source !== "personal" || trade.status !== "open")
      throw new Error("עסקה פתוחה לא נמצאה");
    now = executionTime(input, trade.enteredAt, now);
    return close(userId, trade, input.price, "reported", now);
  });
}
function close(userId, trade, price, reason, now) {
  const exitFee = 0;
  const pnl = (price - trade.entry) * trade.shares;
  return store.putUser(userId, "trade", trade.id, {
    ...trade,
    status: "closed",
    exit: price,
    exitFee,
    pnl,
    exitReason: reason,
    closedAt: new Date(now).toISOString(),
    r: Number.isFinite(trade.stop) && trade.stop < trade.entry && trade.entryFee != null
      ? pnl /
        (trade.shares * (trade.entry - trade.stop) +
          trade.entryFee +
          0)
      : null,
  });
}
function exitFromBar(trade, bar) {
  if (bar.l <= trade.stop)
    return { price: Math.min(trade.stop, bar.o), reason: "stop" };
  if (bar.h >= trade.target) return { price: trade.target, reason: "target" };
  return null;
}
function track(userId, trade, bars, quote, now = Date.now()) {
  if (trade.trackingPlanMode === "none" || (trade.trackingPlanMode == null && (!Number.isFinite(trade.stop) || !Number.isFinite(trade.target)))) {
    const updated = {
      ...trade,
      lastPrice: quote?.price ?? trade.lastPrice,
      priceAt: quote?.at ?? trade.priceAt,
      lastCheckedAt: new Date(now).toISOString(),
    };
    store.putUser(userId, "trade", trade.id, updated);
    return updated;
  }
  // Never use the whole entry candle (which contains pre-entry prices). A missing interval is
  // explicitly marked as unobserved; we never claim tick-accurate execution from OHLC bars.
  const since = Date.parse(trade.lastCheckedAt || trade.enteredAt);
  const after = (bars || [])
    .filter(
      (b) =>
        Date.parse(b.t) >= since &&
        Date.parse(b.t) + 300000 <= now &&
        Date.parse(b.t) < Date.parse(trade.deadline),
    )
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  let hit = null,
    at = now;
  for (const bar of after) {
    hit = exitFromBar(trade, bar);
    if (hit) {
      at = Date.parse(bar.t) + 300000;
      break;
    }
  }
  if (!hit && now >= Date.parse(trade.deadline)) {
    const last = after.at(-1);
    if (last && Date.parse(last.t) + 300000 === Date.parse(trade.deadline)) {
      hit = { price: last.c, reason: "time" };
      at = Date.parse(trade.deadline);
    }
  }
  if (!hit && quote && Date.parse(quote.at) > Date.parse(trade.enteredAt)) {
    if (quote.price <= trade.stop) hit = { price: quote.price, reason: "stop" };
    else if (quote.price >= trade.target)
      hit = { price: trade.target, reason: "target" };
    else if (now >= Date.parse(trade.deadline))
      hit = { price: quote.price, reason: "time" };
  }
  if (!hit && now >= Date.parse(trade.deadline) && !quote) {
    notices.event(
      userId,
      `overdue:${trade.id}`,
      "מועד היציאה הגיע",
      `${trade.ticker}: אין מחיר טרי; בדוק את העסקה אצל הברוקר`,
      "warning",
    );
  }
  const updated = {
    ...trade,
    lastPrice: quote?.price ?? trade.lastPrice,
    priceAt: quote?.at ?? trade.priceAt,
    lastCheckedAt: after.length
      ? new Date(Date.parse(after.at(-1).t) + 300000).toISOString()
      : trade.lastCheckedAt,
    dataGap:
      trade.dataGap ||
      (now - since > 600000 &&
        (!after.length || Date.parse(after[0].t) - since > 300000)),
  };
  if (hit && trade.source === "simulation") {
    const slippage =
      hit.reason === "target" ? 0 : (trade.slippagePct || 0) / 100;
    return close(userId, updated, hit.price * (1 - slippage), hit.reason, at);
  }
  if (hit && trade.source === "personal") {
    updated.exitAlert = hit.reason;
    notices.event(
      userId,
      `exit:${trade.id}:${hit.reason}`,
      "בדוק יציאה אצל הברוקר",
      `${trade.ticker}: ${hit.reason === "stop" ? "המחיר הגיע לסטופ" : hit.reason === "target" ? "המחיר הגיע ליעד" : "הגיע מועד היציאה"}. לא בוצעה מכירה.`,
      "exit",
    );
  }
  store.putUser(userId, "trade", trade.id, updated);
  return updated;
}
function simulate(userId, signal, quote, now = Date.now()) {
  if (
    !signal.sizing?.feasible ||
    !quote ||
    Date.parse(quote.at) <= Date.parse(signal.createdAt) ||
    now >= Date.parse(signal.expiresAt)
  )
    return;
  const settings = config.read(userId);
  const entry = quote.price * (1 + settings.slippagePct / 100);
  if (entry < signal.entry || entry > signal.maxEntry || entry >= signal.target)
    return;
  const opened = store
    .listUser(userId, "trade")
    .filter((t) => t.source === "simulation" && t.status === "open");
  if (
    opened.some((t) => t.ticker === signal.ticker) ||
    store.getUser(userId, "trade", `sim:${signal.id}`) ||
    opened.length >= settings.maxPositions
  )
    return;
  const today = nyDate(now);
  const loss = store
    .listUser(userId, "trade")
    .filter(
      (t) =>
        t.source === "simulation" &&
        t.status === "closed" &&
        nyDate(Date.parse(t.closedAt)) === today,
    )
    .reduce((s, t) => s + t.pnl, 0);
  if (loss <= (-settings.equity * settings.dailyLossPct) / 100) return;
  const reserved = opened.reduce(
    (s, t) => s + t.entry * t.shares + t.entryFee,
    0,
  );
  const sizing = config.size({ ...signal, entry }, settings, reserved);
  if (!sizing.feasible) return;
  const id = `sim:${signal.id}`;
  store.putUser(userId, "trade", id, {
    id,
    signalId: signal.id,
    ticker: signal.ticker,
    strategy: signal.strategy,
    version: signal.version,
    source: "simulation",
    status: "open",
    entry,
    shares: sizing.shares,
    stop: signal.stop,
    target: signal.target,
    deadline: signal.deadline,
    mode: signal.mode,
    enteredAt: new Date(now).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    entryFee: sizing.entryFee,
    feeMode: settings.fees,
    slippagePct: settings.slippagePct,
  });
}
function statistics(trades) {
  return ["simulation", "personal"].map((source) => {
    const rows = trades.filter(
      (t) => t.source === source && t.status === "closed",
    );
    return {
      source,
      n: rows.length,
      pnl: rows.length ? rows.reduce((s, t) => s + t.pnl, 0) : null,
      winRate: rows.length
        ? (rows.filter((t) => t.pnl > 0).length / rows.length) * 100
        : null,
      avgR: rows.filter((t) => Number.isFinite(t.r)).length
        ? rows.filter((t) => Number.isFinite(t.r)).reduce((s, t) => s + t.r, 0) /
          rows.filter((t) => Number.isFinite(t.r)).length
        : null,
      rObservations: rows.filter((t) => Number.isFinite(t.r)).length,
    };
  });
}
module.exports = {
  personalEntry,
  personalClose,
  track,
  simulate,
  exitFromBar,
  statistics,
};

const { randomUUID } = require("node:crypto");
const store = require("./store");
const config = require("./settings");
const notices = require("./notifications");
const { nyDate } = require("./market");
function positive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${label} חייב להיות מספר חיובי`);
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
  positive(input.price, "מחיר");
  positive(input.shares, "כמות");
  const signal = store.getUser(userId, "signal", signalId);
  if (!signal) throw new Error("האיתות לא נמצא");
  now = executionTime(input, signal.createdAt, now);
  if (input.price <= signal.stop || input.price >= signal.target)
    throw new Error(
      "מחיר הביצוע מחוץ לטווח הסטופ והיעד; אי אפשר להצמיד תוכנית זו",
    );
  if (
    input.fees != null &&
    (typeof input.fees !== "number" ||
      input.fees < 0 ||
      !Number.isFinite(input.fees))
  )
    throw new Error("עמלה לא תקינה");
  // Entries are user reports of trades already executed, not order submission or authorization.
  return store.transaction(() => {
    if (
      store
        .listUser(userId, "trade")
        .some(
          (t) =>
            t.signalId === signalId &&
            t.source === "personal" &&
            t.status === "open",
        )
    )
      throw new Error("כבר דיווחת על כניסה לאיתות זה");
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
      stop: signal.stop,
      target: signal.target,
      deadline: signal.deadline,
      mode: signal.mode,
      enteredAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      entryFee:
        input.fees ?? config.fee(input.shares, input.price, settings.fees),
      feeMode: settings.fees,
    });
  });
}
function personalClose(userId, id, input, now = Date.now()) {
  positive(input.price, "מחיר יציאה");
  if (
    input.fees != null &&
    (typeof input.fees !== "number" ||
      input.fees < 0 ||
      !Number.isFinite(input.fees))
  )
    throw new Error("עמלה לא תקינה");
  return store.transaction(() => {
    const trade = store.getUser(userId, "trade", id);
    if (!trade || trade.source !== "personal" || trade.status !== "open")
      throw new Error("עסקה פתוחה לא נמצאה");
    now = executionTime(input, trade.enteredAt, now);
    return close(userId, trade, input.price, "reported", now, input.fees);
  });
}
function close(userId, trade, price, reason, now, fees) {
  const exitFee = fees ?? config.fee(trade.shares, price, trade.feeMode);
  const pnl = (price - trade.entry) * trade.shares - trade.entryFee - exitFee;
  return store.putUser(userId, "trade", trade.id, {
    ...trade,
    status: "closed",
    exit: price,
    exitFee,
    pnl,
    exitReason: reason,
    closedAt: new Date(now).toISOString(),
    r:
      pnl /
      (trade.shares * (trade.entry - trade.stop) +
        trade.entryFee +
        config.fee(trade.shares, trade.stop, trade.feeMode)),
  });
}
function exitFromBar(trade, bar) {
  if (bar.l <= trade.stop)
    return { price: Math.min(trade.stop, bar.o), reason: "stop" };
  if (bar.h >= trade.target) return { price: trade.target, reason: "target" };
  return null;
}
function track(userId, trade, bars, quote, now = Date.now()) {
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
      `${trade.ticker}: אין מחיר טרי; בדוק את העסקה ב־Blink`,
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
      "בדוק יציאה ב־Blink",
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
      avgR: rows.length
        ? rows.reduce((s, t) => s + t.r, 0) / rows.length
        : null,
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

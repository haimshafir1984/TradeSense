const orders = require("./orders");

function resolveBrokerSymbol(signal) {
  if (typeof signal?.brokerSymbol === "string" && signal.brokerSymbol.trim()) return signal.brokerSymbol.trim();
  // An explicit mapping wins. Otherwise the plain ticker is used: the MT4 EA appends the broker suffix ("#" at Colmex).
  let mapped = null;
  try {
    mapped = JSON.parse(process.env.EXECUTION_SYMBOL_MAP_JSON || "{}")?.[signal?.ticker];
  } catch {
    mapped = null;
  }
  if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  const ticker = typeof signal?.ticker === "string" ? signal.ticker.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : null;
}

// This is the only planned boundary between v3 signals and future execution.
// It persists an order intent; it never contacts a broker or an MT4 terminal.
function queueSignal({ userId, signal, brokerAccountId = null, symbol = signal?.brokerSymbol || signal?.ticker, now = Date.now() }) {
  if (!signal || !signal.id) throw new Error("איתות חסר");
  const quantity = Number(signal.sizing?.shares ?? signal.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("לא ניתן ליצור הוראה ללא כמות מאושרת");
  return orders.create({
    symbol,
    side: signal.side || "buy",
    quantity,
    brokerAccountId,
    signalId: signal.id,
    strategy: signal.strategy,
    limitPrice: signal.maxEntry || signal.entry || null,
    stopLoss: signal.stop,
    takeProfit: signal.target,
    idempotencyKey: `signal:${userId}:${signal.id}:${brokerAccountId || "default"}`,
    metadata: { source: "autopilot-signal", signalVersion: signal.version || null },
  }, userId, now);
}

module.exports = { queueSignal, resolveBrokerSymbol };

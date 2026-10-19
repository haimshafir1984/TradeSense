const orders = require("./orders");

// Colmex lists a limited set of US stocks, named by company ("Apple", not "AAPL"); the EA appends the "#" suffix.
// Verified in the MT4 Symbols dialog (US Equities#). Johnson&J is omitted: "&" is not an allowed symbol character.
const COLMEX_US = {
  MMM: "3M", AMD: "AMD", MO: "Altria", AMZN: "Amazon", AXP: "AmericanEX", AAPL: "Apple", BAC: "BAC", "BRK.B": "BRK.B",
  BA: "Boeing", AVGO: "Broadcom", CAT: "CAT", CVX: "Chevron", CSCO: "Cisco", C: "Citigroup", COST: "Costco",
  LLY: "Eli.Lilly", XOM: "Exxon", GE: "GE", GS: "Goldman", GOOGL: "Google", GOOG: "Google", HD: "Home.Depot", IBM: "IBM",
  INTC: "Intel", JPM: "JPMorgan", KO: "KO", LMT: "LMT", MA: "MA", META: "META", MCD: "McDonalds", MU: "Micron",
  MSFT: "Microsoft", NFLX: "NFLX", NKE: "NIKE", NVDA: "NVDA", PFE: "PFE", QCOM: "QUALCOMM", SBUX: "Starbucks",
  TSLA: "Tesla", UNH: "U.Health", V: "Visa", WFC: "WFC", WMT: "Walmart", DIS: "WaltDisney",
};

// Returns the broker symbol without suffix, or null when the broker does not trade this stock.
function resolveBrokerSymbol(signal) {
  if (typeof signal?.brokerSymbol === "string" && signal.brokerSymbol.trim()) return signal.brokerSymbol.trim();
  const ticker = typeof signal?.ticker === "string" ? signal.ticker.trim().toUpperCase() : "";
  let custom = {};
  try {
    custom = JSON.parse(process.env.EXECUTION_SYMBOL_MAP_JSON || "{}") || {};
  } catch {
    custom = {};
  }
  const mapped = custom[signal?.ticker] ?? custom[ticker] ?? COLMEX_US[ticker];
  return typeof mapped === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(mapped.trim()) ? mapped.trim() : null;
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

module.exports = { queueSignal, resolveBrokerSymbol, COLMEX_US };

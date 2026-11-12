// Alpaca Trading API client for the paper account only. Hardcoded to the paper host: this arm must
// never be pointed at a live account by a config mistake, the same way the MT4 side rejects any
// account that isn't identified as demo. Separate credentials from the data-only Alpaca key already
// used elsewhere (ALPACA_API_KEY_ID/SECRET): ALPACA_TRADER_API_KEY_ID / ALPACA_TRADER_API_SECRET_KEY.
const BASE_URL = "https://paper-api.alpaca.markets/v2";

function isConfigured() {
  return Boolean(process.env.ALPACA_TRADER_API_KEY_ID && process.env.ALPACA_TRADER_API_SECRET_KEY);
}

function headers() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_TRADER_API_KEY_ID || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_TRADER_API_SECRET_KEY || "",
    "Content-Type": "application/json",
  };
}

async function call(path, { method = "GET", body } = {}) {
  if (!isConfigured()) {
    const error = new Error("מפתחות Alpaca Trader לא מוגדרים");
    error.code = "not_configured";
    throw error;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error body; fall through with json=null.
  }
  if (!response.ok) {
    const error = new Error(json?.message || `Alpaca ${method} ${path} failed: HTTP ${response.status}`);
    error.status = response.status;
    error.alpaca = json;
    throw error;
  }
  return json;
}

// { equity, cash, portfolio_value, buying_power, daytrade_count, account_blocked, trading_blocked }
async function getAccount() {
  return call("/account");
}

async function getPositions() {
  return call("/positions");
}

// Daily equity series for the paper account: { timestamp[], equity[], profit_loss[], profit_loss_pct[], base_value }.
async function getPortfolioHistory({ period = "3M", timeframe = "1D" } = {}) {
  return call(`/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}`);
}

async function getOrders({ status = "open", limit = 100, after, direction } = {}) {
  const extra = (after ? `&after=${encodeURIComponent(after)}` : "") + (direction ? `&direction=${encodeURIComponent(direction)}` : "");
  return call(`/orders?status=${encodeURIComponent(status)}&limit=${limit}${extra}`);
}

// side: "buy" | "sell". qty is whole or fractional shares (Alpaca accepts fractional for market day orders).
async function placeMarketOrder({ symbol, qty, side }) {
  return call("/orders", {
    method: "POST",
    body: { symbol, qty: String(qty), side, type: "market", time_in_force: "day" },
  });
}

async function closePosition(symbol) {
  return call(`/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

module.exports = { BASE_URL, isConfigured, getAccount, getPositions, getPortfolioHistory, getOrders, placeMarketOrder, closePosition };

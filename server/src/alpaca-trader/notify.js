// Push notifications for the Alpaca arm: one for every buy and every exit. It reuses the app's existing push
// pipeline (autopilot/notifications.js: per-user event log + outbox, flushed to the devices that user subscribed).
//
// Opt-in per profile: the Alpaca account is shared by everyone who opens the site, but only profiles that switched
// notifications on in the Alpaca tab are notified. Sending is best-effort: a failure here must never touch trading.
const store = require("../autopilot/store");

const K_USERS = "alpacaTrader:notifyUsers";

const STRATEGY_LABEL = {
  orb15: "פריצת טווח פתיחה", orb15_retest: "פריצה ובדיקה חוזרת", vwap_reclaim: "חזרה מעל VWAP",
  vwap_pullback: "תיקון ל-VWAP", reversal5: "התאוששות קצרה", pullback2_v1: "תיקון יומיים", breakout20_v1: "פריצת שיא 20 יום",
};
const EXIT_LABEL = {
  stop: "סטופ", breakeven_stop: "סטופ ב-break-even", target: "יעד", end_of_day: "סגירת סוף יום",
  daily_loss_breached: "מגבלת הפסד יומי", partial_target: "מימוש חלקי ביעד", trailing_stop: "סטופ נגרר", carried_over: "נסגרה בפתיחה (נשארה מיום קודם)",
};

function isEnabled(userId) {
  return Boolean(userId && store.get(K_USERS, userId));
}

function setEnabled(userId, enabled) {
  if (!userId) throw new Error("חסר פרופיל");
  if (enabled) store.put(K_USERS, userId, { userId, enabledAt: new Date().toISOString() });
  else store.remove(K_USERS, userId);
  return { enabled: Boolean(enabled) };
}

const usd = (value) => (Number.isFinite(value) ? `$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 2 })}` : "—");
const signedUsd = (value) => (Number.isFinite(value) ? `${value < 0 ? "-" : "+"}${usd(value)}` : "—");
const price = (value) => (Number.isFinite(value) ? `$${value.toFixed(2)}` : "—");

// bought: true bypasses the per-user "only purchases" push filter: here both buys and exits are wanted.
function send(id, title, body, type) {
  let sent = 0;
  for (const userId of store.listIds(K_USERS)) {
    try {
      require("../autopilot/notifications").event(userId, id, title, body, type, { bought: true });
      sent += 1;
    } catch {
      // keep going: one profile's failure must not block the others
    }
  }
  return sent;
}

function entered({ symbol, shares, price: planned, equity, stop, target, score, strategies = [], orderId, now = Date.now() }) {
  try {
    const amount = shares * planned;
    const share = Number.isFinite(equity) && equity > 0 ? ` (${((amount / equity) * 100).toFixed(0)}% מהתיק)` : "";
    const names = strategies.map((s) => STRATEGY_LABEL[s] || s).join(", ");
    const body = [
      `${shares.toLocaleString("en-US")} מניות במחיר ~${price(planned)}, סכום ${usd(amount)}${share}`,
      `סטופ ${price(stop)} · יעד ${price(target)}`,
      `ציון ${score}${names ? ` · ${names}` : ""}`,
    ].join("\n");
    return send(`alpaca:entry:${orderId || `${symbol}:${now}`}`, `Alpaca · נקנתה ${symbol}`, body, "signal");
  } catch {
    return 0;
  }
}

function exited({ symbol, reason, qty, price: exitPrice, entryPrice, pnl, now = Date.now() }) {
  try {
    const label = EXIT_LABEL[reason] || reason;
    const lines = [`${Number(qty).toLocaleString("en-US")} מניות · מחיר ~${price(exitPrice)}${Number.isFinite(entryPrice) ? ` (כניסה ${price(entryPrice)})` : ""}`];
    if (Number.isFinite(pnl)) lines.push(`רווח/הפסד משוער: ${signedUsd(pnl)}`);
    return send(`alpaca:exit:${symbol}:${now}`, `Alpaca · יציאה מ-${symbol} (${label})`, lines.join("\n"), "info");
  } catch {
    return 0;
  }
}

module.exports = { isEnabled, setEnabled, entered, exited, STRATEGY_LABEL, EXIT_LABEL };

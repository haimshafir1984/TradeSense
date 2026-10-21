const store = require("../autopilot/store");

// Exit-side decisions for the decision log: tier sales, stop moves, end-of-day and loss-limit closes,
// and trades that MT4 closed (stop, target, manual). One shared account, so the log is not per user.
const KIND = "executionExitLog";
const MAX = 300;
let seq = 0;

function record(entry, now = Date.now()) {
  const at = new Date(now).toISOString();
  const id = `${at}:${String(seq++ % 1000).padStart(3, "0")}`;
  store.put(KIND, id, { id, at, kind: "exit", ...entry });
  const ids = store.list(KIND).map((e) => e.id).sort();
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) store.remove(KIND, old);
}

const REASONS = { loss: "הגעה למגבלת ההפסד היומי", eod: "סגירה לקראת סוף יום המסחר" };

// Turns the exit manager's actions of one evaluation into log rows.
function recordActions(actions, positions, now = Date.now()) {
  const symbolOf = (ticket) => {
    const p = (positions || []).find((x) => String(x.ticket) === String(ticket));
    return (p?.symbol || "").replace(/#$/, "") || String(ticket);
  };
  for (const a of actions || []) {
    const symbol = symbolOf(a.ticket);
    if (a.type === "close" && a.reason) record({ outcome: "exit_close", symbol, reasonText: REASONS[a.reason] || a.reason }, now);
    else if (a.type === "close") record({ outcome: "exit_close", symbol, reasonText: `מכירת כל הפוזיציה במדרגת רווח ${a.tiers?.join("+") || ""}`.trim() }, now);
    else if (a.type === "partial_close") record({ outcome: "exit_partial", symbol, qty: a.lots, reasonText: `מכירה חלקית של ${a.lots} במדרגת רווח ${a.tiers?.join("+") || ""}`.trim() }, now);
    else if (a.type === "modify_stop") record({ outcome: "stop_moved", symbol, reasonText: `הזזת סטופ ל־${a.stopLoss}` }, now);
    else if (a.type === "tier_skipped" || a.type === "stop_skipped") record({ outcome: "exit_skipped", symbol, reasonText: a.note }, now);
    else if (a.type === "halt" || a.type === "error") record({ outcome: "exit_error", symbol, reasonText: a.note || a.reason || "שגיאה בניהול הפוזיציה" }, now);
  }
}

function list() {
  return store.list(KIND);
}

module.exports = { KIND, record, recordActions, list };

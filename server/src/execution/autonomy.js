const store = require("../autopilot/store");

const MODES = ["off", "scanner", "autonomous"];
const HEARTBEAT_TTL_MS = 90_000;

function state() {
  const control = {
    mode: "off",
    reason: "ברירת מחדל בטוחה: מסחר עצמאי כבוי",
    changedAt: null,
    ...store.get("runtime", "execution-control"),
    agent: store.get("runtime", "execution-agent") || null,
  };
  if (control.mode === "autonomous" && !agentConnected())
    return { ...control, mode: "error", reason: "ה־heartbeat של MT4 פג; מסחר חדש נעצר עד לאימות מחדש" };
  return control;
}

function agentConnected(now = Date.now()) {
  const agent = store.get("runtime", "execution-agent");
  return Boolean(agent && agent.isDemo === true && Date.parse(agent.lastSeenAt || 0) >= now - HEARTBEAT_TTL_MS);
}

function heartbeat(input = {}, now = Date.now()) {
  if (typeof input.accountId !== "string" || !input.accountId.trim()) throw new Error("חשבון MT4 חסר");
  if (input.isDemo !== true) throw new Error("MT4 אינו מזוהה כחשבון דמו");
  const agent = {
    agentId: typeof input.agentId === "string" ? input.agentId.slice(0, 80) : "mt4-ea",
    accountId: input.accountId.trim(),
    isDemo: true,
    lastSeenAt: new Date(now).toISOString(),
  };
  store.put("runtime", "execution-agent", agent);
  return agent;
}

function setMode(mode, now = Date.now()) {
  if (!MODES.includes(mode)) {
    const error = new Error("מצב מסחר לא תקין");
    error.status = 400;
    throw error;
  }
  if (mode === "autonomous") {
    if (process.env.EXECUTION_AUTONOMY_ENABLED !== "true") {
      const error = new Error("מסחר עצמאי אינו מאופשר בשרת המקומי");
      error.code = "autonomy_not_configured";
      error.status = 409;
      throw error;
    }
    if (!agentConnected(now)) {
      const error = new Error("MT4 אינו מחובר ומאומת כחשבון דמו");
      error.code = "mt4_not_ready";
      error.status = 409;
      throw error;
    }
  }
  const next = { mode, reason: mode === "autonomous" ? "מסחר עצמאי פעיל" : mode === "scanner" ? "סריקה ללא ביצוע" : "מסחר עצמאי כבוי", changedAt: new Date(now).toISOString() };
  store.put("runtime", "execution-control", next);
  return state();
}

module.exports = { MODES, HEARTBEAT_TTL_MS, state, agentConnected, heartbeat, setMode };

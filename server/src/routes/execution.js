const express = require("express");
const orders = require("../execution/orders");
const users = require("../autopilot/users");
const autonomy = require("../execution/autonomy");
const positions = require("../execution/positions");
const closeRequests = require("../execution/closeRequests");
const riskProfile = require("../execution/riskProfile");
const exitManager = require("../execution/exitManager");
const entryProfile = require("../execution/entryProfile");
const entryDecision = require("../execution/entryDecision");

const router = express.Router();

function executorOnly(req, res, next) {
  const token = req.headers["x-execution-agent-token"];
  if (!orders.canUseExecutorToken(token)) return res.status(process.env.EXECUTION_AGENT_TOKEN ? 401 : 503).json({ error: "execution agent is not configured" });
  req.executor = true;
  next();
}

function handleError(error, res) {
  res.status(error.status || 400).json({ error: error.message });
}

// Human dashboard access is scoped to the authenticated profile and is read-only.
router.get("/orders", users.requireUser, (req, res) => {
  res.json({ orders: orders.listForUser(req.userId) });
});

// The dashboard can change the execution mode, but autonomous mode remains fail-closed
// until the server is explicitly configured and a demo-only EA heartbeat is fresh.
router.get("/control", users.requireUser, (_req, res) => {
  const current = autonomy.state();
  res.json({
    ...current,
    agentConnected: autonomy.agentConnected(),
    // Read-only facts so the dashboard can explain why starting autonomous trading is blocked.
    autonomyEnabled: process.env.EXECUTION_AUTONOMY_ENABLED === "true",
    queueEnabled: process.env.EXECUTION_QUEUE_ENABLED === "true",
  });
});

router.post("/control", users.requireUser, (req, res) => {
  try {
    // The first activation of a US trading day fixes the base for the daily loss limit.
    if (req.body?.mode === "autonomous" && process.env.EXECUTION_AUTONOMY_ENABLED === "true") riskProfile.ensureDayBase();
    res.json(autonomy.setMode(req.body?.mode));
  } catch (error) {
    handleError(error, res);
  }
});

// The future EA uses a separate token and can see the execution queue, but cannot create orders.
router.get("/agent/orders", executorOnly, (req, res) => {
  const accountId = req.query.accountId || null;
  if (!accountId) return res.status(400).json({ error: "accountId is required" });
  const rows = orders.listAll().filter((order) => order.brokerAccountId === accountId);
  // The queue exposes only unclaimed intents. Reconciliation of claimed/submitted
  // orders will use a separate status lookup so a second EA cannot execute them again.
  res.json({ orders: rows.filter((order) => order.status === "pending") });
});

// Read-only account/position snapshot reported by the EA and shown in the dashboard.
router.post("/agent/positions", executorOnly, (req, res) => {
  try {
    positions.save(req.body || {});
    res.json({ ok: true });
    // Every fresh report drives the exit manager; its failure must never break the report itself.
    exitManager.evaluate().catch((error) => console.warn(`[execution] exit manager: ${error.message}`));
  } catch (error) {
    handleError(error, res);
  }
});

// Risk rules (limits, concurrency, stop loss, take-profit tiers, end of day) and the live state they produce.
router.get("/risk-profile", users.requireUser, (_req, res) => {
  const profile = riskProfile.read();
  res.json({ profile, defaults: riskProfile.DEFAULTS, day: riskProfile.evaluateDay(Date.now(), profile), manager: exitManager.view() });
});

router.put("/risk-profile", users.requireUser, (req, res) => {
  try {
    const profile = riskProfile.save(req.body || {});
    res.json({ profile, day: riskProfile.evaluateDay(Date.now(), profile) });
  } catch (error) {
    handleError(error, res);
  }
});

// Realized profit/loss by day, week (Mon-Fri), month, quarter and year, on New York trading dates.
router.get("/entry", users.requireUser, (req, res) => {
  res.json(entryDecision.view(req.userId));
});

router.put("/entry", users.requireUser, (req, res) => {
  try {
    entryProfile.save(req.body || {});
    res.json(entryDecision.view(req.userId));
  } catch (error) {
    handleError(error, res);
  }
});

router.get("/premarket-log", users.requireUser, (req, res) => {
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  res.json({ samples: require("../autopilot/premarketLog").list(date) });
});

router.get("/pnl", users.requireUser, (_req, res) => {
  res.json(require("../execution/pnlHistory").summary());
});

router.get("/positions", users.requireUser, (_req, res) => {
  res.json(positions.current());
});

// Manual close of one MT4 position. Needs an explicit confirm flag; the EA performs the close
// (demo only, TradeSense-managed positions only) and reports back.
router.post("/positions/:ticket/close", users.requireUser, (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      const error = new Error("נדרש אישור מפורש לסגירת הפוזיציה");
      error.status = 400;
      throw error;
    }
    const { request, duplicate } = closeRequests.create({ ticket: req.params.ticket, userId: req.userId });
    res.status(duplicate ? 200 : 201).json({ request, duplicate });
  } catch (error) {
    handleError(error, res);
  }
});

router.get("/close-requests", users.requireUser, (req, res) => {
  closeRequests.sweep();
  res.json({ requests: closeRequests.listForUser(req.userId) });
});

router.get("/agent/close-requests", executorOnly, (req, res) => {
  const accountId = req.query.accountId || null;
  if (!accountId) return res.status(400).json({ error: "accountId is required" });
  res.json({ requests: closeRequests.pendingForAccount(String(accountId)) });
});

router.post("/agent/close-requests/:id/status", executorOnly, (req, res) => {
  try {
    res.json(closeRequests.transition(req.params.id, req.body?.status, req.body || {}));
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/agent/heartbeat", executorOnly, (req, res) => {
  try {
    res.json({ agent: autonomy.heartbeat(req.body || {}), state: autonomy.state() });
  } catch (error) {
    handleError(error, res);
  }
});

router.get("/agent/orders/:id", executorOnly, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "הוראה לא נמצאה" });
  if (req.query.accountId && order.brokerAccountId !== req.query.accountId)
    return res.status(404).json({ error: "הוראה לא נמצאה" });
  res.json(order);
});

router.get("/orders/:id", users.requireUser, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order || order.userId !== req.userId) return res.status(404).json({ error: "הוראה לא נמצאה" });
  res.json(order);
});

// Only the separately authenticated execution agent may claim or report lifecycle changes.
router.post("/agent/orders/:id/status", executorOnly, (req, res) => {
  try {
    const order = orders.transition(req.params.id, req.body?.status, req.body || {});
    res.json(order);
  } catch (error) {
    handleError(error, res);
  }
});

module.exports = router;

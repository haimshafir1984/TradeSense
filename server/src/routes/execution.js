const express = require("express");
const orders = require("../execution/orders");
const users = require("../autopilot/users");
const autonomy = require("../execution/autonomy");

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
  res.json({ ...current, agentConnected: autonomy.agentConnected() });
});

router.post("/control", users.requireUser, (req, res) => {
  try {
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

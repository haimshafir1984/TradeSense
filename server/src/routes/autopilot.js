const express = require("express");
const router = express.Router();
const store = require("../autopilot/store");
const settings = require("../autopilot/settings");
const tracking = require("../autopilot/tracking");
const engine = require("../autopilot/engine");
const notices = require("../autopilot/notifications");
const { STRATEGIES } = require("../autopilot/strategies");
router.get("/legacy", async (_req, res, next) => {
  try {
    res.json(await require("../services/portfolioStore").readPortfolio());
  } catch (e) {
    next(e);
  }
});
router.get("/dashboard", (_req, res) => {
  const now = Date.now();
  const signals = store
    .list("signal")
    .slice(0, 250)
    .map((s) => ({
      ...s,
      status:
        s.status === "active"
          ? now >= Date.parse(s.expiresAt)
            ? "expired"
            : now - Date.parse(s.priceAt) > 90000
              ? "stale"
              : "active"
          : s.status,
    }));
  const trades = store.list("trade");
  const runtime = store.get("runtime", "engine") || {};
  res.json({
    settings: settings.read(),
    runtime: {
      ...runtime,
      healthy: now - Date.parse(runtime.heartbeatAt) < 120000,
    },
    strategies: STRATEGIES,
    signals,
    trades: trades.slice(0, 500),
    stats: tracking.statistics(trades),
    events: store.list("event").slice(0, 60),
    pushDevices: store.list("subscription").length,
  });
});
router.patch("/settings", (req, res, next) => {
  try {
    res.json(settings.save(req.body));
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.post("/scan", (_req, res) => {
  engine.requestScan();
  res.status(202).json({ accepted: true });
});
router.post("/signals/:id/entry", (req, res, next) => {
  try {
    res.status(201).json(tracking.personalEntry(req.params.id, req.body));
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.post("/trades/:id/close", (req, res, next) => {
  try {
    res.json(tracking.personalClose(req.params.id, req.body));
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.get("/push/key", (_req, res) =>
  res.json({ publicKey: notices.keys().publicKey }),
);
router.post("/push/subscribe", (req, res, next) => {
  try {
    notices.subscribe(req.body);
    res.json({ ok: true });
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.post("/push/test", async (_req, res, next) => {
  try {
    notices.event(
      `test:${Date.now()}`,
      "ההתראות מחוברות",
      "תקבל כאן איתותים חדשים ועדכוני מעקב.",
    );
    await notices.flush();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.get("/export", (_req, res) => {
  res
    .attachment("tradesense-history.json")
    .json({
      exportedAt: new Date().toISOString(),
      signals: store.list("signal"),
      trades: store.list("trade"),
      settings: settings.read(),
    });
});
router.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: err.status ? err.message : "הפעולה לא הושלמה. נסה שוב." });
});
module.exports = router;

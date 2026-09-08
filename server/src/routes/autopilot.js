const express = require("express");
const router = express.Router();
const store = require("../autopilot/store");
const settings = require("../autopilot/settings");
const tracking = require("../autopilot/tracking");
const engine = require("../autopilot/engine");
const notices = require("../autopilot/notifications");
const users = require("../autopilot/users");
const { STRATEGIES } = require("../autopilot/strategies");

router.post("/session", (req, res, next) => {
  try {
    res.json(users.session(req.body));
  } catch (e) {
    e.status = e.status || 400;
    next(e);
  }
});

router.use(users.requireUser);

router.get("/legacy", (_req, res) => {
  res.json({ holdings: [], watchlist: [] });
});
router.get("/dashboard", (req, res) => {
  const now = Date.now();
  const signals = store
    .listUser(req.userId, "signal")
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
  const trades = store.listUser(req.userId, "trade");
  const runtime = store.get("runtime", "engine") || {};
  res.json({
    userId: req.userId,
    settings: settings.read(req.userId),
    runtime: {
      ...runtime,
      healthy: now - Date.parse(runtime.heartbeatAt) < 120000,
    },
    strategies: STRATEGIES,
    signals,
    trades: trades.slice(0, 500),
    stats: tracking.statistics(trades),
    events: store.listUser(req.userId, "event").slice(0, 60),
    pushDevices: store.listUser(req.userId, "subscription").length,
  });
});
router.patch("/settings", (req, res, next) => {
  try {
    res.json(settings.save(req.body, req.userId));
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
    res
      .status(201)
      .json(tracking.personalEntry(req.userId, req.params.id, req.body));
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.post("/trades/:id/close", (req, res, next) => {
  try {
    res.json(tracking.personalClose(req.userId, req.params.id, req.body));
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
    notices.subscribe(req.userId, req.body);
    res.json({ ok: true });
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
router.post("/push/test", async (req, res, next) => {
  try {
    notices.event(
      req.userId,
      `test:${Date.now()}`,
      "ההתראות מחוברות",
      "תקבל כאן איתותים חדשים ועדכוני מעקב.",
    );
    await notices.flush([req.userId]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.get("/export", (req, res) => {
  res
    .attachment("tradesense-history.json")
    .json({
      exportedAt: new Date().toISOString(),
      signals: store.listUser(req.userId, "signal"),
      trades: store.listUser(req.userId, "trade"),
      settings: settings.read(req.userId),
    });
});
router.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: err.status ? err.message : "הפעולה לא הושלמה. נסה שוב." });
});
module.exports = router;

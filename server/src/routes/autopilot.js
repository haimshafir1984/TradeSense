const express = require("express");
const router = express.Router();
const store = require("../autopilot/store");
const settings = require("../autopilot/settings");
const tracking = require("../autopilot/tracking");
const engine = require("../autopilot/engine");
const notices = require("../autopilot/notifications");
const users = require("../autopilot/users");
const { STRATEGIES } = require("../autopilot/strategies");
const market = require("../autopilot/market");
const recommendations = require("../autopilot/recommendations");

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
  const candidateRecord = store.getUser(req.userId, "candidate", "latest");
  const currentSettings = settings.read(req.userId);
  const candidates = (candidateRecord?.rows || []).filter((candidate) => {
    const observed = Date.parse(candidate.observedAt || 0);
    const strategy = STRATEGIES.find((item) => item.key === candidate.strategy);
    return (
      Number.isFinite(observed) &&
      now - observed <= 600000 &&
      market.nyDate(observed) === market.nyDate(now) &&
      strategy &&
      !currentSettings.excludedSymbols.includes(candidate.ticker) &&
      currentSettings.strategies.includes(candidate.strategy) &&
      (currentSettings.mode === "both" || currentSettings.mode === strategy.mode) &&
      !(currentSettings.risk === "balanced" && strategy.risk === "aggressive")
    );
  });
  res.json({
    userId: req.userId,
    settings: currentSettings,
    runtime: {
      ...runtime,
      healthy: now - Date.parse(runtime.heartbeatAt) < 120000,
      marketDiagnostics: runtime.marketDiagnostics || null,
      personalDiagnostics:
        runtime.personalDiagnostics?.[req.userId] || candidateRecord?.counters || null,
    },
    strategies: STRATEGIES,
    signals,
    candidates: candidates.slice(0, 20),
    recommendationSummary: recommendations.summaryForUser(req.userId),
    recommendations: recommendations.listForUser(req.userId, { limit: 25 }).rows,
    trades: trades.slice(0, 500),
    stats: tracking.statistics(trades),
    events: store.listUser(req.userId, "event").slice(0, 60),
    pushDevices: store.listUser(req.userId, "subscription").length,
  });
});
router.get("/recommendations/review-summary", (req, res) => {
  res.json(recommendations.summaryForUser(req.userId));
});
router.get("/recommendations", (req, res) => {
  res.json(recommendations.listForUser(req.userId, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  }));
});
router.get("/recommendations/:id", (req, res, next) => {
  const item = recommendations.getForUser(req.userId, req.params.id);
  if (!item) {
    const error = new Error("ההמלצה לא נמצאה");
    error.status = 404;
    return next(error);
  }
  res.json(item);
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
    e.status = e.status || (e.code === "request_conflict" ? 409 : e.code === "plan_invalid" ? 400 : 400);
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
      recommendations: recommendations.listForUser(req.userId, { limit: 100 }).rows,
      recommendationSummary: recommendations.summaryForUser(req.userId),
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

const express = require("express");
const users = require("../autopilot/users");
const settings = require("../alpaca-trader/settings");
const engine = require("../alpaca-trader/engine");
const notify = require("../alpaca-trader/notify");

const router = express.Router();

function handleError(error, res) {
  res.status(error.status || 400).json({ error: error.message });
}

router.use(users.requireUser);

// Full view for the "חשבון דמו Alpaca" tab: account, positions, today's candidates, decisions, exits.
router.get("/status", async (req, res, next) => {
  try {
    res.json({ ...(await engine.view()), notify: { enabled: notify.isEnabled(req.userId) } });
  } catch (error) {
    next(error);
  }
});

router.patch("/settings", (req, res) => {
  try {
    res.json(settings.save(req.body));
  } catch (error) {
    handleError(error, res);
  }
});

// Per-profile opt-in for a push notification on every Alpaca buy and exit.
router.put("/notify", (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") throw new Error("ערך לא תקין: התראות");
    res.json(notify.setEnabled(req.userId, req.body.enabled));
  } catch (error) {
    handleError(error, res);
  }
});

module.exports = router;

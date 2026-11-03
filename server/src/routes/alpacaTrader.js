const express = require("express");
const users = require("../autopilot/users");
const settings = require("../alpaca-trader/settings");
const engine = require("../alpaca-trader/engine");

const router = express.Router();

function handleError(error, res) {
  res.status(error.status || 400).json({ error: error.message });
}

router.use(users.requireUser);

// Full view for the "חשבון דמו Alpaca" tab: account, positions, today's candidates, decisions, exits.
router.get("/status", async (_req, res, next) => {
  try {
    res.json(await engine.view());
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

module.exports = router;

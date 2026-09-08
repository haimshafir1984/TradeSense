const express = require("express");
const cors = require("cors");
const portfolioRouter = require("./routes/portfolio");
// On-demand only (never called by any scan) - see docs/SPEC_VIBE_TRADING_INTEGRATION.md.
const backtestRouter = require("./routes/backtest");
// Manual research tool's on-demand check endpoint (docs/SPEC_ANOMALY_MINING.md section 11) -
// self-contained (takes a `tickers` array), so it survives the v2 rebuild untouched even though
// nothing currently calls it from the client (docs/SPEC_V2_ARCHITECTURE.md §2: research/** stays
// but is deliberately kept out of the new pipeline).
const anomalyMatchRouter = require("./routes/anomalyMatch");
// The real v2 API (§6/§10 phase 8) - candidates wires the whole pipeline through
// pipeline/candidatesService.js, and every candidate it returns is also logged to the forward
// ledger automatically (§5.7).
const candidatesRouter = require("./routes/candidates");
const playbooksRouter = require("./routes/playbooks");
const ledgerRouter = require("./routes/ledger");

const app = express();
const { timingSafeEqual } = require("node:crypto");

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  }),
);
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

// Single-user access control for the public deployment, including legacy personal data routes.
app.use("/api", (req, res, next) => {
  const secret = process.env.APP_ACCESS_TOKEN;
  if (!secret && process.env.NODE_ENV === "production")
    return res
      .status(503)
      .json({ error: "יש להגדיר APP_ACCESS_TOKEN בשרת לפני הפעלה" });
  if (secret) {
    const supplied = (req.headers.authorization || "").replace(/^Bearer /, "");
    const a = Buffer.from(supplied),
      b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return res.status(401).json({ error: "נדרש קוד גישה" });
  }
  const origin = req.headers.origin;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    origin &&
    origin !== (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  )
    return res.status(403).json({ error: "מקור בקשה לא מורשה" });
  next();
});
app.use("/api/autopilot", require("./routes/autopilot"));
app.use("/api/candidates", candidatesRouter);
app.use("/api/playbooks", playbooksRouter);
app.use("/api/ledger", ledgerRouter);

app.use("/api/portfolio", portfolioRouter);
app.use("/api/backtest", backtestRouter);
app.use("/api/anomaly-match", anomalyMatchRouter);

module.exports = app;

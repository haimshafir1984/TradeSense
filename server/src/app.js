const fs = require("node:fs");
const path = require("node:path");
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

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  }),
);
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

// Basic origin guard for the public deployment. Autopilot user separation is handled
// inside routes/autopilot.js because each browser profile owns its own code.
app.use("/api", (req, res, next) => {
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

// Single-container deployments (Dockerfile) serve the built client from the same origin. With no
// client/dist present (dev, the Render API service) nothing is registered and behaviour is unchanged.
const clientDist = path.resolve(process.env.CLIENT_DIST_DIR || path.join(__dirname, "../../client/dist"));
if (fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders(res, file) {
        if (path.basename(file) === "sw.js" || path.basename(file) === "index.html") {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

module.exports = app;

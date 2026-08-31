const express = require('express');
const cors = require('cors');
const portfolioRouter = require('./routes/portfolio');
// On-demand only (never called by any scan) - see docs/SPEC_VIBE_TRADING_INTEGRATION.md.
const backtestRouter = require('./routes/backtest');
// Manual research tool's on-demand check endpoint (docs/SPEC_ANOMALY_MINING.md section 11) -
// self-contained (takes a `tickers` array), so it survives the v2 rebuild untouched even though
// nothing currently calls it from the client (docs/SPEC_V2_ARCHITECTURE.md §2: research/** stays
// but is deliberately kept out of the new pipeline).
const anomalyMatchRouter = require('./routes/anomalyMatch');
const candidatesRouter = require('./routes/candidates');

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173'
  })
);
app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

// v2 rebuild in progress (docs/SPEC_V2_ARCHITECTURE.md). /api/analyze and the whole watchlist
// family are deleted (§2); the new /api/candidates contract (§6) is being built phase by phase
// starting at §10 phase 3 and returns a explicit "not built yet" response until then, rather than
// a 404 that looks like a routing bug.
app.use('/api/candidates', candidatesRouter);

app.use('/api/portfolio', portfolioRouter);
app.use('/api/backtest', backtestRouter);
app.use('/api/anomaly-match', anomalyMatchRouter);

module.exports = app;

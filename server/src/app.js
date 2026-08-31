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
// The real v2 API (§6/§10 phase 8) - candidates wires the whole pipeline through
// pipeline/candidatesService.js, and every candidate it returns is also logged to the forward
// ledger automatically (§5.7).
const candidatesRouter = require('./routes/candidates');
const playbooksRouter = require('./routes/playbooks');
const ledgerRouter = require('./routes/ledger');

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

app.use('/api/candidates', candidatesRouter);
app.use('/api/playbooks', playbooksRouter);
app.use('/api/ledger', ledgerRouter);

app.use('/api/portfolio', portfolioRouter);
app.use('/api/backtest', backtestRouter);
app.use('/api/anomaly-match', anomalyMatchRouter);

module.exports = app;

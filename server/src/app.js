const express = require('express');
const cors = require('cors');
const analyzeRouter = require('./routes/analyze');

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

app.use('/api/analyze', analyzeRouter);

module.exports = app;

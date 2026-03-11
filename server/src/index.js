const path = require('path');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: rootEnvPath });

const app = require('./app');

const port = Number(process.env.PORT || 4000);

console.log(`[startup] Loaded env from ${rootEnvPath}`);
console.log(`[startup] DATA_MODE=${process.env.DATA_MODE || 'undefined'} FINNHUB_API_KEY=${process.env.FINNHUB_API_KEY ? 'present' : 'missing'} CLIENT_ORIGIN=${process.env.CLIENT_ORIGIN || 'undefined'}`);

app.listen(port, () => {
  console.log(`TradeSense API listening on port ${port}`);
});
// eod-1 downloader: SPY 5-minute IEX bars, 2018-01 .. validation end (2024-12-31). Resumable (one file per month).
// Deliberately does NOT fetch the locked periods (2025, 2026): see protocol.json "gates.locked".
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const alpaca = require('../../server/src/providers/alpacaService');

const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const DIR = path.join(__dirname, 'data', 'spy5m');
fs.mkdirSync(DIR, { recursive: true });
const startYear = Number(P.periods.warmup[0].slice(0, 4));
const end = P.periods.validation[1]; // 2024-12-31

async function main() {
  for (let y = startYear; y <= Number(end.slice(0, 4)); y++) {
    for (let m = 1; m <= 12; m++) {
      const tag = `${y}-${String(m).padStart(2, '0')}`;
      const file = path.join(DIR, `${tag}.json`);
      if (fs.existsSync(file)) continue;
      const from = new Date(Date.UTC(y, m - 1, 1));
      const to = new Date(Math.min(Date.UTC(y, m, 1), Date.parse(`${end}T23:59:59Z`)));
      if (from > to) continue;
      const bars = (await alpaca.getIntradayBars({ symbols: ['SPY'], timeframe: '5Min', start: from, end: to, feed: 'iex' })).get('SPY') || [];
      fs.writeFileSync(file, JSON.stringify(bars));
      console.log(`${tag}: ${bars.length} bars`);
    }
  }
}
main().catch((e) => { console.error('download failed:', e.message); process.exit(1); });

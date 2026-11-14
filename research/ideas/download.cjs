// ideas-2 downloader. Resumable. Never fetches the locked period (2025+). Stores compact regular-hours candles only:
// data/m5/<group>/<YYYY-MM>.json = { SYMBOL: [[date, i, o, h, l, c], ...] }, i = candle index 0..77 (09:30..15:55 New York).
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const alpaca = require('../../server/src/providers/alpacaService');
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const D = path.join(__dirname, 'data');
const END = '2024-12-31';

const U = JSON.parse(fs.readFileSync(path.join(D, 'universe.json'))).symbols;
const pairs = JSON.parse(fs.readFileSync(path.join(D, 'pairs.json'))).pairs;
const hf = Object.values(P.hypotheses.HF.groups).flatMap(([leader, fol]) => [leader, ...fol]);
const bases = [...new Set(pairs.map((p) => p.base))];
const GROUPS = [
  { name: 'U', symbols: ['SPY', ...U], from: '2020-07-27' },
  { name: 'HF', symbols: [...new Set(hf)].filter((s) => !U.includes(s)), from: '2020-07-27' },
  { name: 'HE', symbols: bases.filter((s) => !U.includes(s) && !hf.includes(s)), from: '2023-01-01' },
];

const offsetCache = new Map();
function nyOffsetHours(dateKey) { // 4 (EDT) or 5 (EST) for that UTC date at noon
  if (!offsetCache.has(dateKey)) {
    const noon = new Date(`${dateKey}T17:00:00Z`);
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(noon));
    offsetCache.set(dateKey, 17 - (h === 24 ? 0 : h));
  }
  return offsetCache.get(dateKey);
}
function compact(bars) {
  const out = [];
  for (const b of bars) {
    const t = Date.parse(b.t);
    const key = b.t.slice(0, 10);
    const off = nyOffsetHours(key);
    const minutes = new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes() - off * 60; // local minutes of day (the UTC date equals the local date during the regular session)
    const i = (minutes - 570) / 5;
    if (i < 0 || i > 77 || !Number.isInteger(i)) continue;
    out.push([key, i, b.o, b.h, b.l, b.c]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Own fetch with retry/backoff: the service's fail-soft path silently dropped chunks on HTTP 429 (found by checking candle counts per month).
async function getJson(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY } });
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  throw new Error('gave up after retries');
}
async function fetchBars(symbols, from, to) {
  const res = new Map();
  for (let i = 0; i < symbols.length; i += 20) {
    const chunkSyms = symbols.slice(i, i + 20);
    let token = null;
    do {
      const params = new URLSearchParams({ symbols: chunkSyms.join(','), timeframe: '5Min', start: from.toISOString(), end: to.toISOString(), limit: '10000', adjustment: 'split', feed: 'iex', sort: 'asc' });
      if (token) params.set('page_token', token);
      const j = await getJson('https://data.alpaca.markets/v2/stocks/bars?' + params);
      for (const [sym, bars] of Object.entries(j.bars || {})) res.set(sym, (res.get(sym) || []).concat(bars));
      token = j.next_page_token || null;
      await sleep(350);
    } while (token);
  }
  return res;
}

async function intraday() {
  for (const g of GROUPS) {
    const dir = path.join(D, 'm5', g.name);
    fs.mkdirSync(dir, { recursive: true });
    let y = Number(g.from.slice(0, 4)), m = Number(g.from.slice(5, 7));
    while (`${y}-${String(m).padStart(2, '0')}` <= END.slice(0, 7)) {
      const tag = `${y}-${String(m).padStart(2, '0')}`;
      const file = path.join(dir, `${tag}.json`);
      if (!fs.existsSync(file)) {
        const from = new Date(Math.max(Date.UTC(y, m - 1, 1), Date.parse(`${g.from}T00:00:00Z`)));
        const to = new Date(Math.min(Date.UTC(y, m, 1), Date.parse(`${END}T23:59:59Z`)));
        const res = await fetchBars(g.symbols, from, to);
        const obj = {};
        for (const [sym, bars] of res) obj[sym] = compact(bars);
        fs.writeFileSync(file, JSON.stringify(obj));
        console.log(`${g.name} ${tag}: ${Object.keys(obj).length} symbols, ${Object.values(obj).reduce((s, a) => s + a.length, 0)} candles`);
      }
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }
}

async function daily() { // HE ratio proxy: SIP daily bars of the ETFs and bases, 2022-06 .. 2024-12
  const file = path.join(D, 'daily_he.json');
  if (fs.existsSync(file)) return;
  const symbols = [...new Set([...pairs.map((p) => p.etf), ...bases])];
  const res = await alpaca.getBarsDetailed({ symbols, timeframe: '1Day', start: '2022-06-01', end: `${END}T23:59:59Z`, feed: 'sip', adjustment: 'split' });
  const obj = {};
  for (const [sym, bars] of res.bars) obj[sym] = bars.map((b) => [b.t.slice(0, 10), b.c, b.v]);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`daily_he: ${Object.keys(obj).length} symbols, failed ${res.failedSymbols?.length || 0}`);
}

(async () => { await daily(); await intraday(); console.log('done'); })().catch((e) => { console.error('download failed:', e.message); process.exit(1); });

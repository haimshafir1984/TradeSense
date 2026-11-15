// Shared helpers for round2: throttled Alpaca client (<=100 req/min, pauses during New York market hours on weekdays), NY time helpers.
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const HEADERS = { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY };
const MIN_GAP_MS = 620; // ~97 requests per minute at most
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function inLiveWindow(now = Date.now()) { // weekday 09:00-16:30 New York: the live app is active, stay away
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return m >= 9 * 60 && m <= 16 * 60 + 30;
}

async function get(url, { host = 'data' } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    while (inLiveWindow()) await sleep(60000);
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let r;
    try { r = await fetch(url, { headers: HEADERS }); } catch (e) { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(Math.min(120000, 4000 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 120)}`);
    try { return await r.json(); } catch (e) { await sleep(5000 * (attempt + 1)); continue; } // connection dropped while reading the body: retry
  }
  throw new Error('gave up after retries: ' + url.slice(0, 120));
}

const offCache = new Map();
function nyOffsetHours(dateKey) { // 4 (EDT) or 5 (EST) at noon UTC of that date
  if (!offCache.has(dateKey)) {
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(`${dateKey}T17:00:00Z`)));
    offCache.set(dateKey, 17 - (h === 24 ? 0 : h));
  }
  return offCache.get(dateKey);
}
const nyToIso = (dateKey, hhmm) => new Date(Date.parse(`${dateKey}T${hhmm}:00Z`) + nyOffsetHours(dateKey) * 3600000).toISOString();

function* pagedBars({ symbols, timeframe, start, end, feed = 'sip' }) { /* placeholder to keep API shape simple */ }

async function bars({ symbols, timeframe, start, end, feed = 'sip', adjustment = 'split' }) {
  const out = new Map();
  let token = null;
  do {
    const p = new URLSearchParams({ symbols: symbols.join(','), timeframe, start, end, limit: '10000', adjustment, feed, sort: 'asc' });
    if (token) p.set('page_token', token);
    const j = await get('https://data.alpaca.markets/v2/stocks/bars?' + p);
    for (const [s, arr] of Object.entries(j.bars || {})) (out.get(s) || out.set(s, []).get(s)).push(...arr);
    token = j.next_page_token || null;
  } while (token);
  return out;
}

// One download script at a time (the rate cap is per process, so two would double it): a blocking lock with stale-pid detection.
async function acquireDownloadLock() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const file = path.join(__dirname, 'data', 'download.lock');
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      const release = () => { try { fs.unlinkSync(file); } catch {} };
      process.on('exit', release); process.on('SIGINT', () => { release(); process.exit(1); });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const pid = Number(fs.readFileSync(file, 'utf8')); process.kill(pid, 0); } catch (k) { if (k.code === 'ESRCH') { try { fs.unlinkSync(file); } catch {} continue; } }
      await sleep(5000);
    }
  }
}

module.exports = { acquireDownloadLock, get, bars, sleep, nyToIso, nyOffsetHours, inLiveWindow, fs, path };

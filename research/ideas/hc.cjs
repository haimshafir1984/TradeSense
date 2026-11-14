// ideas-2 HC: offering/dilution headline on stocks that jumped >= +5% by 10:00. Verifies the frozen protocol hash first.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const H = P.hypotheses.HC;
const D = path.join(__dirname, 'data');
const U = JSON.parse(fs.readFileSync(path.join(D, 'universe.json'))).symbols;

// --- candles of U (same compact files as analyze.cjs), forward-filled; >= 25 real candles
const days = new Map();
for (const f of fs.readdirSync(path.join(D, 'm5', 'U')).sort()) {
  const obj = JSON.parse(fs.readFileSync(path.join(D, 'm5', 'U', f)));
  for (const sym of U) for (const [date, i, o, h, l, c] of obj[sym] || []) {
    const m = days.get(sym) || days.set(sym, new Map()).get(sym);
    const d = m.get(date) || m.set(date, { o: new Float64Array(78).fill(NaN), c: new Float64Array(78).fill(NaN), real: new Uint8Array(78) }).get(date);
    d.o[i] = o; d.c[i] = c; d.real[i] = 1;
  }
}
for (const m of days.values()) for (const [date, d] of m) {
  let n = 0, last = NaN; for (let i = 0; i < 78; i++) n += d.real[i];
  if (n < 25) { m.delete(date); continue; }
  for (let i = 0; i < 78; i++) { if (d.real[i]) last = d.c[i]; else { d.c[i] = last; d.o[i] = last; } }
}
const allDates = [...new Set([...days.values()].flatMap((m) => [...m.keys()]))].sort();

// candidates: c[5] / previous session close - 1 >= +5%
const cand = [];
for (const [sym, m] of days) for (const [date, d] of m) {
  const prev = allDates[allDates.indexOf(date) - 1];
  const pc = m.get(prev)?.c[77];
  if (!Number.isFinite(pc) || !(d.c[5] / pc - 1 >= 0.05)) continue;
  const out = d.c[77] / d.o[7] - 1;
  if (Number.isFinite(out)) cand.push({ sym, date, prev, out });
}
console.log(`candidates (jump >= 5% by 10:00): ${cand.length}`);

// --- news (cached): headlines between 16:00 ET of the previous day and 10:00 ET of the day
const newsFile = path.join(D, 'news.json');
const cache = fs.existsSync(newsFile) ? JSON.parse(fs.readFileSync(newsFile)) : {};
const nyOff = (date) => { const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(`${date}T17:00:00Z`))); return 17 - (h === 24 ? 0 : h); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function news(c) {
  const key = `${c.sym}|${c.date}`;
  if (cache[key]) return cache[key];
  const start = new Date(Date.parse(`${c.prev}T${String(16 + nyOff(c.prev)).padStart(2, '0')}:00:00Z`)).toISOString();
  const end = new Date(Date.parse(`${c.date}T${String(10 + nyOff(c.date)).padStart(2, '0')}:00:00Z`)).toISOString();
  const url = `https://data.alpaca.markets/v1beta1/news?symbols=${c.sym}&start=${start}&end=${end}&limit=50&sort=asc`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY } });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`news ${r.status}`);
    const j = await r.json();
    cache[key] = (j.news || []).map((n) => n.headline);
    return cache[key];
  }
  throw new Error('news rate limited');
}
(async () => {
  let fetched = 0;
  for (const c of cand) {
    if (!cache[`${c.sym}|${c.date}`]) { await news(c); fetched += 1; await sleep(120); if (fetched % 200 === 0) { fs.writeFileSync(newsFile, JSON.stringify(cache)); console.log(`news fetched ${fetched}`); } }
  }
  fs.writeFileSync(newsFile, JSON.stringify(cache));
  const kw = H.offeringKeywords.map((k) => k.toLowerCase());
  for (const c of cand) { c.heads = cache[`${c.sym}|${c.date}`] || []; c.off = c.heads.some((h) => kw.some((k) => h.toLowerCase().includes(k))); }

  function evaluate(period) {
    const rows = cand.filter((c) => c.date >= period[0] && c.date <= period[1]);
    const byDate = new Map();
    for (const c of rows) { const g = byDate.get(c.date) || byDate.set(c.date, { off: [], non: [] }).get(c.date); (c.off ? g.off : g.non).push(c.out); }
    const list = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
    const diffOf = (gs) => mean(gs.flatMap((g) => g.off)) - mean(gs.flatMap((g) => g.non));
    let a = [...P.id].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0), 7);
    const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const N = list.length; let ge = 0, valid = 0;
    for (let k = 0; k < 2000 && N >= 5; k++) {
      const sample = []; while (sample.length < N) { const s = Math.floor(rand() * N); for (let b = 0; b < 20 && sample.length < N; b++) sample.push(list[(s + b) % N]); }
      const d = diffOf(sample); if (!Number.isFinite(d)) continue; valid += 1; if (d >= 0) ge += 1;
    }
    const offN = rows.filter((c) => c.off).length;
    return { stockDays: rows.length, offeringEvents: offN, dates: N, meanOffering: mean(rows.filter((c) => c.off).map((c) => c.out)), meanNoOffering: mean(rows.filter((c) => !c.off).map((c) => c.out)), diff: diffOf(list), p: valid ? Math.max(ge / valid, 1 / 2000) : 1, enough: offN >= H.minEvents && N >= H.minEventDates };
  }
  const dev = evaluate(P.common.periods.development);
  dev.diffOk = dev.diff <= -0.005;
  const out = { development: dev };
  if (process.argv.includes('--validation')) out.validation = evaluate(P.common.periods.validation); // only after the final Holm gate passed
  fs.writeFileSync(path.join(__dirname, 'results-hc.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(dev, null, 1));
})().catch((e) => { console.error('hc failed:', e.message); process.exit(1); });

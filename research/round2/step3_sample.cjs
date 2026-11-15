// Step 3: eligibility from the daily bars of the WHOLE pool, the seeded sample S (400 stocks), and the 5-minute SIP candles of S
// (regular hours only, one file per trading day, resumable). Development + warm-up only.
const crypto = require('node:crypto');
const { bars, fs, path, nyToIso } = require('./lib.cjs');
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const D = path.join(__dirname, 'data');
const DEV = P.common.periods.stocks.development;

// ---- daily data of the whole pool
const daily = new Map(); // symbol -> [{date,o,h,l,c,v}]
for (const f of fs.readdirSync(path.join(D, 'daily')).sort()) {
  for (const [sym, arr] of Object.entries(JSON.parse(fs.readFileSync(path.join(D, 'daily', f))))) daily.set(sym, arr.map(([date, o, h, l, c, v]) => ({ date, o, h, l, c, v })));
}
const dayCounts = new Map();
for (const arr of daily.values()) for (const b of arr) dayCounts.set(b.date, (dayCounts.get(b.date) || 0) + 1);
const sessions = [...dayCounts.entries()].filter(([, n]) => n >= 1000).map(([d]) => d).sort();
console.log(`pool symbols with data ${daily.size}, sessions ${sessions.length}`);

// ---- eligibility per symbol-day (dailyEligibility in the protocol)
const elig = new Map(); // symbol -> Map date -> {h1, h2}
const counts = {}; // date -> {h1, h2}
for (const [sym, arr] of daily) {
  const m = new Map();
  for (let i = 20; i < arr.length; i++) {
    const date = arr[i].date;
    if (date < DEV[0] || date > DEV[1]) continue;
    if ((Date.parse(date) - Date.parse(arr[i - 20].date)) / 86400000 > 45) continue; // gaps: not enough recent sessions
    const prev14 = arr.slice(i - 14, i), prev20 = arr.slice(i - 20, i);
    const adv14 = prev14.reduce((s, b) => s + b.v, 0) / 14;
    const dollar20 = prev20.reduce((s, b) => s + b.c * b.v, 0) / 20;
    let atr = 0;
    for (let k = i - 14; k < i; k++) { const b = arr[k], pc = arr[k - 1].c; atr += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
    atr /= 14;
    const h1 = arr[i].o > 5 && adv14 >= 1e6 && atr > 0.5;
    const h2 = arr[i].o > 5 && dollar20 >= 2e7;
    if (h1 || h2) m.set(date, { h1, h2, atr });
    const c = (counts[date] ||= { h1: 0, h2: 0 });
    if (h1) c.h1 += 1;
    if (h2) c.h2 += 1;
  }
  elig.set(sym, m);
}
fs.writeFileSync(path.join(D, 'eligibility_counts.json'), JSON.stringify(counts));

// ---- sample S: >= 100 H1-eligible development days, seeded sha256 ordering
const candidates = [...elig.entries()].filter(([, m]) => [...m.values()].filter((x) => x.h1).length >= 100).map(([s]) => s);
const seed = 'round2-1-sample';
const S = candidates.map((s) => ({ s, h: crypto.createHash('sha256').update(seed + s).digest('hex') })).sort((a, b) => a.h.localeCompare(b.h)).slice(0, 400).map((x) => x.s);
fs.writeFileSync(path.join(D, 'sample.json'), JSON.stringify({ seed, candidates: candidates.length, symbols: S }));
console.log(`candidates with >=100 eligible days: ${candidates.length}; sample ${S.length}`);

fs.writeFileSync(path.join(D, 'daily_S.json'), JSON.stringify(Object.fromEntries(S.map((sym) => [sym, daily.get(sym).map((b) => [b.date, b.o, b.h, b.l, b.c, b.v])]))));
fs.writeFileSync(path.join(D, 'elig_S.json'), JSON.stringify(Object.fromEntries(S.map((sym) => [sym, Object.fromEntries([...elig.get(sym)].map(([d, x]) => [d, [x.h1 ? 1 : 0, x.h2 ? 1 : 0, x.atr]]))]))));
// ---- which symbol-days need 5-minute data: eligible on any of the sessions [t-1 .. t+20]
const devSessions = sessions.filter((d) => d >= '2020-12-01' && d <= DEV[1]);
const needByDay = new Map();
for (const sym of S) {
  const m = elig.get(sym);
  const flags = devSessions.map((d) => m.has(d));
  for (let i = 0; i < devSessions.length; i++) {
    let need = false;
    for (let k = Math.max(0, i - 1); k <= Math.min(devSessions.length - 1, i + 20); k++) if (flags[k]) { need = true; break; }
    if (need) (needByDay.get(devSessions[i]) || needByDay.set(devSessions[i], []).get(devSessions[i])).push(sym);
  }
}
const totalSymbolDays = [...needByDay.values()].reduce((s, a) => s + a.length, 0);
console.log(`symbol-days to download: ${totalSymbolDays} (~${Math.round(totalSymbolDays * 78 / 2300)} requests)`);

(async () => {
  await require('./lib.cjs').acquireDownloadLock();
  fs.mkdirSync(path.join(D, 'm5'), { recursive: true });
  let done = 0;
  for (const date of devSessions) {
    const file = path.join(D, 'm5', `${date}.json`);
    if (fs.existsSync(file)) { done += 1; continue; }
    const syms = needByDay.get(date) || [];
    const obj = {};
    for (let i = 0; i < syms.length; i += 100) {
      const res = await bars({ symbols: syms.slice(i, i + 100), timeframe: '5Min', start: nyToIso(date, '09:30'), end: nyToIso(date, '16:00') });
      for (const [s, arr] of res) obj[s] = arr.map((b) => { const t = new Date(b.t); const idx = (t.getUTCHours() * 60 + t.getUTCMinutes() - (Date.parse(nyToIso(date, '09:30')) / 60000 % 1440)) / 5; return [idx, b.o, b.h, b.l, b.c, b.v]; }).filter((r) => Number.isInteger(r[0]) && r[0] >= 0 && r[0] <= 77);
    }
    fs.writeFileSync(file, JSON.stringify(obj));
    done += 1;
    if (done % 20 === 0) console.log(`day ${done}/${devSessions.length} ${date}: ${Object.keys(obj).length} symbols`);
  }
  console.log('step3 done');
})().catch((e) => { console.error('step3 failed:', e.message); process.exit(1); });

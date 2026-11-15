// Step 3b: 1-minute SIP candles (regular hours) of the stocks selected by h1_select.cjs (top K and control K), one file per day.
const { bars, fs, path, nyToIso, acquireDownloadLock } = require('./lib.cjs');
const D = path.join(__dirname, 'data');
(async () => {
  await acquireDownloadLock();
  const sel = JSON.parse(fs.readFileSync(path.join(D, 'h1_selection.json')));
  fs.mkdirSync(path.join(D, 'm1'), { recursive: true });
  const dates = Object.keys(sel).sort();
  let done = 0;
  for (const date of dates) {
    const file = path.join(D, 'm1', `${date}.json`);
    if (fs.existsSync(file)) { done += 1; continue; }
    const syms = [...new Set([...sel[date].top, ...sel[date].control])];
    const obj = {};
    const base = Date.parse(nyToIso(date, '09:30')) / 60000;
    for (let i = 0; i < syms.length; i += 25) {
      const res = await bars({ symbols: syms.slice(i, i + 25), timeframe: '1Min', start: nyToIso(date, '09:30'), end: nyToIso(date, '16:00') });
      for (const [s, arr] of res) obj[s] = arr.map((b) => [Date.parse(b.t) / 60000 - base, b.o, b.h, b.l, b.c]).filter((r) => r[0] >= 0 && r[0] < 390);
    }
    fs.writeFileSync(file, JSON.stringify(obj));
    done += 1;
    if (done % 25 === 0) console.log(`day ${done}/${dates.length} ${date}: ${Object.keys(obj).length} symbols`);
  }
  console.log('step3b done');
})().catch((e) => { console.error('step3b failed:', e.message); process.exit(1); });

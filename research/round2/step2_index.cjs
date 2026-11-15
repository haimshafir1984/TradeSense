// Step 2: SPY and QQQ 5-minute SIP candles. Development period only unless --locked is passed (after a development pass).
const { bars, fs, path } = require('./lib.cjs');
const { compact5 } = require('./compact.cjs');
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const locked = process.argv.includes('--locked');
if (locked) { // gated: only after the development Holm gate of H3 or C2 was recorded as passed (final_dev.json written by final_dev.cjs)
  const f = path.join(__dirname, 'final_dev.json');
  const ok = fs.existsSync(f) && (JSON.parse(fs.readFileSync(f)).pass || {});
  if (!ok || !(ok.H3 || ok.C2)) { console.log('locked index period is gated: no development pass recorded yet. Nothing downloaded.'); process.exit(0); }
}
const range = locked ? P.common.periods.indexEtfs.locked : P.common.periods.indexEtfs.development;
const DIR = path.join(__dirname, 'data', 'index'); fs.mkdirSync(DIR, { recursive: true });
(async () => {
  await require('./lib.cjs').acquireDownloadLock();
  let [y, m] = range[0].slice(0, 7).split('-').map(Number);
  const [ey, em] = range[1].slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const tag = `${y}-${String(m).padStart(2, '0')}`;
    const file = path.join(DIR, `${tag}.json`);
    if (!fs.existsSync(file)) {
      const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
      const end = new Date(Math.min(Date.UTC(y, m, 1), Date.parse(`${range[1]}T23:59:00Z`))).toISOString();
      const res = await bars({ symbols: ['SPY', 'QQQ'], timeframe: '5Min', start, end });
      const obj = {};
      for (const [s, arr] of res) obj[s] = compact5(arr);
      fs.writeFileSync(file, JSON.stringify(obj));
      console.log(tag, Object.fromEntries(Object.entries(obj).map(([s, a]) => [s, a.length])));
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  console.log('step2 done', locked ? '(locked)' : '(development)');
})().catch((e) => { console.error('step2 failed:', e.message); process.exit(1); });

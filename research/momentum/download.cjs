// momentum-1 download: development window by default; --locked only after development passed.
const L = require('../round2/lib.cjs');
const { fs, path } = L;
const locked = process.argv.includes('--locked');
if (locked) {
  const f = path.join(__dirname, 'results-dev.json');
  if (!fs.existsSync(f) || !JSON.parse(fs.readFileSync(f)).pass) { console.log('locked period is gated: development did not pass'); process.exit(0); }
}
const [start, end] = locked ? ['2020-06-01', '2026-11-05'] : ['2016-01-01', '2022-01-10'];
const dir = path.join(__dirname, 'data', locked ? 'locked' : 'dev');

(async () => {
  await L.acquireDownloadLock();
  fs.mkdirSync(dir, { recursive: true });
  const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '../round2/data/pool.json')));
  const symbols = pool.map((r) => r.symbol);
  const CH = 100;
  const pull = async (syms, file) => {
    if (fs.existsSync(file)) return;
    const res = await L.bars({ symbols: syms, timeframe: '1Day', start: `${start}T00:00:00Z`, end: `${end}T23:59:00Z`, adjustment: 'all' });
    const obj = {};
    for (const [s, arr] of res) obj[s] = arr.map((b) => [b.t.slice(0, 10), b.o, b.c, b.v]);
    fs.writeFileSync(file, JSON.stringify(obj));
  };
  await pull(['SPY'], path.join(dir, 'SPY.json'));
  for (let i = 0; i < symbols.length; i += CH) {
    await pull(symbols.slice(i, i + CH), path.join(dir, `${String(i / CH).padStart(3, '0')}.json`));
    if ((i / CH) % 20 === 0) console.log(`chunk ${i / CH} of ${Math.ceil(symbols.length / CH)}`);
  }
  console.log('download done');
})().catch((e) => { console.error('download failed:', e.message); process.exit(1); });

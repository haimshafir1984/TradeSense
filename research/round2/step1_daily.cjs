// Step 1: stock pool (active + inactive common stocks) and their daily SIP bars 2020-11-01 .. 2023-12-31 (development + warm-up only).
const { get, bars, fs, path } = require('./lib.cjs');
const D = path.join(__dirname, 'data'); fs.mkdirSync(path.join(D, 'daily'), { recursive: true });
const inc = /common stock|ordinary shares|common shares/i, exc = /(ETF|fund|preferred|warrant|rights|units|notes|depositary|trust)/i;

async function pool() {
  const file = path.join(D, 'pool.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const active = JSON.parse(fs.readFileSync(path.join(__dirname, '../v6/data/assets.json')));
  const inactive = await get('https://paper-api.alpaca.markets/v2/assets?status=inactive&asset_class=us_equity');
  const seen = new Set(), rows = [];
  for (const [list, status] of [[active, 'active'], [inactive, 'inactive']]) for (const a of list) {
    if (!/^[A-Z]{1,5}$/.test(a.symbol) || seen.has(a.symbol)) continue;
    const name = a.name || '';
    if (!inc.test(name) || exc.test(name)) continue;
    seen.add(a.symbol); rows.push({ symbol: a.symbol, name, status });
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  console.log(`pool ${rows.length} (active ${rows.filter((r) => r.status === 'active').length})`);
  return rows;
}

(async () => {
  const rows = await pool();
  const CH = 100;
  for (let i = 0; i < rows.length; i += CH) {
    const file = path.join(D, 'daily', `${String(i / CH).padStart(3, '0')}.json`);
    if (fs.existsSync(file)) continue;
    const syms = rows.slice(i, i + CH).map((r) => r.symbol);
    const res = await bars({ symbols: syms, timeframe: '1Day', start: '2020-11-01T00:00:00Z', end: '2023-12-31T23:59:00Z' });
    const obj = {};
    for (const [s, arr] of res) obj[s] = arr.map((b) => [b.t.slice(0, 10), b.o, b.h, b.l, b.c, b.v]);
    fs.writeFileSync(file, JSON.stringify(obj));
    if ((i / CH) % 10 === 0) console.log(`chunk ${i / CH} of ${Math.ceil(rows.length / CH)}: ${Object.keys(obj).length} symbols with data`);
  }
  console.log('step1 done');
})().catch((e) => { console.error('step1 failed:', e.message); process.exit(1); });

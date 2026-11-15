// Loads the per-day 5-minute files of the sample S: dayData.get(date).get(symbol) = Float32Array(78*5) [o,h,l,c,v] per candle (NaN = no trade)
const { fs, path } = require('./lib.cjs');
const D = path.join(__dirname, 'data');
function load5(from = '2020-12-01', to = '2023-12-31') {
  const dayData = new Map();
  const files = fs.readdirSync(path.join(D, 'm5')).filter((f) => f.slice(0, 10) >= from && f.slice(0, 10) <= to).sort();
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(D, 'm5', f)));
    const m = new Map();
    for (const [sym, rows] of Object.entries(obj)) {
      const a = new Float32Array(78 * 5).fill(NaN);
      for (const [i, o, h, l, c, v] of rows) { const b = i * 5; a[b] = o; a[b + 1] = h; a[b + 2] = l; a[b + 3] = c; a[b + 4] = v; }
      m.set(sym, a);
    }
    dayData.set(f.slice(0, 10), m);
  }
  return { dayData, sessions: [...dayData.keys()].sort() };
}
const O = (a, i) => a[i * 5], H = (a, i) => a[i * 5 + 1], L = (a, i) => a[i * 5 + 2], C = (a, i) => a[i * 5 + 3], V = (a, i) => a[i * 5 + 4];
module.exports = { load5, O, H, L, C, V, D };

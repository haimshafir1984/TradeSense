// momentum-1 analysis. Verifies the frozen protocol; development by default, --locked only after development passed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../round2/stats.cjs');
const { classify } = require('../../server/src/alpaca-trader/fundFilter.js');

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== reg.files['protocol.json'].sha256) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const locked = process.argv.includes('--locked');
if (locked && !JSON.parse(fs.readFileSync(path.join(__dirname, 'results-dev.json'))).pass) { console.log('locked period is gated: development did not pass'); process.exit(0); }
const [FROM, TO] = P.periods[locked ? 'locked' : 'development'];
const dir = path.join(__dirname, 'data', locked ? 'locked' : 'dev');
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '../round2/data/pool.json')));
const info = new Map(pool.map((r) => [r.symbol, r]));

const spy = JSON.parse(fs.readFileSync(path.join(dir, 'SPY.json'))).SPY;
const cal = spy.map((b) => b[0]);
const idx = new Map(cal.map((d, i) => [d, i]));
const bounds = []; // index of the last session of each month (signal day)
for (let i = 0; i + 1 < cal.length; i++) if (cal[i].slice(0, 7) !== cal[i + 1].slice(0, 7)) bounds.push(i);

const stocks = [];
const cover = { active: 0, inactive: 0 };
for (const f of fs.readdirSync(dir).filter((x) => x !== 'SPY.json')) {
  for (const [sym, bars] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f))))) {
    const r = info.get(sym);
    if (!r || classify(r.name).fundLike || !bars.length) continue;
    cover[r.status] += 1;
    const open = new Float64Array(cal.length).fill(NaN), close = new Float64Array(cal.length).fill(NaN), vol = new Float64Array(cal.length).fill(NaN);
    let first = -1, last = -1;
    for (const [d, o, c, v] of bars) { const i = idx.get(d); if (i === undefined) continue; open[i] = o; close[i] = c; vol[i] = v; if (first < 0) first = i; last = i; }
    if (last >= 0) stocks.push({ sym, open, close, vol, first, last });
  }
}

const cache = new Map();
function eligible(t) { // universe + volatility filter at signal index t, ranked by momentum
  if (cache.has(t)) return cache.get(t);
  const out = [];
  for (const s of stocks) {
    if (t - 252 < 0 || !(s.close[t] > 0) || s.first > t - 252) continue;
    let adv = 0, n = 0;
    for (let k = t - 63; k < t; k++) if (s.close[k] > 0) { adv += s.close[k] * s.vol[k]; n++; }
    if (n < 55 || adv / n < 20000000) continue;
    let bars = 0;
    for (let k = s.first; k <= t && bars < 253; k++) if (s.close[k] > 0) bars++;
    if (bars < 253) continue;
    const rets = [];
    for (let k = t - 125; k <= t; k++) if (s.close[k] > 0 && s.close[k - 1] > 0) rets.push(s.close[k] / s.close[k - 1] - 1);
    if (rets.length < 110) continue;
    const a = s.close[t - 21], b = s.close[t - 252];
    if (!(a > 0 && b > 0)) continue;
    out.push({ s, sd: S.std(rets), mom: a / b - 1 });
  }
  out.sort((x, y) => x.sd - y.sd);
  const ranked = out.slice(0, Math.floor(out.length * 0.8)).sort((x, y) => y.mom - x.mom);
  cache.set(t, ranked);
  return ranked;
}

function holdReturn(s, e, x, haircut = 0) { // open[e] -> open[x]; bars ending inside the month exit at the last close
  const entry = s.open[e];
  if (!(entry > 0)) return null;
  if (s.open[x] > 0) return s.open[x] / entry - 1;
  for (let k = x; k >= e; k--) if (s.close[k] > 0) { const dead = s.last < x; return (s.close[k] * (dead ? 1 - haircut : 1)) / entry - 1; }
  return null;
}

function run({ holdings = 20, cost = P.costs.primaryPerSide, haircut = 0 } = {}) {
  const months = [];
  let prev = new Set();
  for (let m = 0; m + 1 < bounds.length; m++) {
    const t = bounds[m], e = t + 1, x = bounds[m + 1] + 1;
    if (x >= cal.length) break;
    const month = cal[e].slice(0, 7);
    if (month < FROM || month > TO) continue;
    const ranked = eligible(t);
    if (ranked.length < 100) continue;
    const picks = [];
    for (const r of ranked) { const ret = holdReturn(r.s, e, x, haircut); if (ret === null) continue; picks.push({ sym: r.s.sym, ret }); if (picks.length === holdings) break; }
    const uni = ranked.map((r) => holdReturn(r.s, e, x, haircut)).filter((v) => v !== null);
    const names = new Set(picks.map((p) => p.sym));
    const bought = picks.filter((p) => !prev.has(p.sym)).length / holdings;
    const sold = [...prev].filter((s) => !names.has(s)).length / holdings;
    prev = names;
    const gross = S.mean(picks.map((p) => p.ret));
    months.push({ date: month, gross, net: gross - cost * (bought + sold), turnover: bought, universe: S.mean(uni), spy: spy[x][1] / spy[e][1] - 1, eligible: ranked.length, picks: picks.map((p) => p.sym) });
  }
  return months;
}

const sharpeM = (xs) => (S.mean(xs) / S.std(xs)) * Math.sqrt(12);
const cagr = (xs) => Math.pow(xs.reduce((a, r) => a * (1 + r), 1), 12 / xs.length) - 1;
function blockPm(values, seed, block = 6, n = 5000) {
  const N = values.length, rand = S.rng(seed);
  let le = 0;
  for (let k = 0; k < n; k++) {
    let sum = 0, c = 0;
    while (c < N) { const st = Math.floor(rand() * N); for (let b = 0; b < block && c < N; b++, c++) sum += values[(st + b) % N]; }
    if (sum <= 0) le++;
  }
  return Math.max(le / n, 1 / n);
}

function summarize(months) {
  const net = months.map((m) => m.net), spyR = months.map((m) => m.spy), uni = months.map((m) => m.universe);
  const exS = months.map((m) => m.net - m.spy), exU = months.map((m) => m.net - m.universe);
  const years = {};
  for (const m of months) { const y = (years[m.date.slice(0, 4)] ||= { net: 1, spy: 1, uni: 1 }); y.net *= 1 + m.net; y.spy *= 1 + m.spy; y.uni *= 1 + m.universe; }
  const byYear = Object.entries(years).map(([year, v]) => ({ year, strategy: v.net - 1, spy: v.spy - 1, universe: v.uni - 1 }));
  const sorted = [...exS].sort((a, b) => b - a);
  const side = (xs) => ({ cagr: cagr(xs), sharpe: sharpeM(xs), maxDrawdown: S.maxDrawdown(xs), monthly: S.mean(xs) });
  return {
    months: months.length, avgEligible: Math.round(S.mean(months.map((m) => m.eligible))), avgTurnover: S.mean(months.map((m) => m.turnover)),
    strategy: { ...side(net), grossMonthly: S.mean(months.map((m) => m.gross)) }, spy: side(spyR), universe: side(uni),
    excessVsSpy: S.mean(exS), pVsSpy: blockPm(exS, P.id + ':spy'), excessVsUniverse: S.mean(exU), pVsUniverse: blockPm(exU, P.id + ':uni'),
    trackingErrorMonthly: S.std(exS), excessVsSpyWithoutBest3Months: S.mean(sorted.slice(3)),
    byYear, yearsBeatingSpy: byYear.filter((y) => y.strategy > y.spy).length,
  };
}

const monthly = run();
const main = summarize(monthly);
const out = { period: [FROM, TO], coverage: cover, ...main };
out.descriptive = {};
for (const [name, opt] of [['cost025', { cost: 0.0025 }], ['holdings50', { holdings: 50 }], ['delistHaircut30', { haircut: 0.3 }]]) {
  const d = summarize(run(opt));
  out.descriptive[name] = { netMonthly: d.strategy.monthly, sharpe: d.strategy.sharpe, excessVsSpy: d.excessVsSpy, excessVsUniverse: d.excessVsUniverse };
}
out.checks = locked
  ? { excessSpy: main.excessVsSpy > 0, excessUniverse: main.excessVsUniverse > 0, sharpe: main.strategy.sharpe > main.spy.sharpe }
  : { excessSpy: main.excessVsSpy > 0, p: main.pVsSpy < 0.10, excessUniverse: main.excessVsUniverse > 0, sharpe: main.strategy.sharpe > main.spy.sharpe, drawdown: Math.abs(main.strategy.maxDrawdown) <= 1.25 * Math.abs(main.spy.maxDrawdown), years: main.yearsBeatingSpy >= 3 };
out.pass = Object.values(out.checks).every(Boolean);
fs.writeFileSync(path.join(__dirname, locked ? 'results-locked.json' : 'results-dev.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(__dirname, locked ? 'months-locked.json' : 'months-dev.json'), JSON.stringify(monthly));
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v), 1));

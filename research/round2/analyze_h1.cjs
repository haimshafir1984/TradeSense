// round2 H1: 5-minute opening-range breakout on Stocks in Play (Zarattini, Barbon, Aziz 2024), identification and stops on 1-minute candles.
// Development period only. Verifies the frozen protocol hash first.
const crypto = require('node:crypto');
const { fs, path } = require('./lib.cjs');
const S = require('./stats.cjs');
const { O, H, L, C, D } = require('./load5.cjs');
const { dayData, sessions, elig, P, DEV } = require('./h1_select.cjs');

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
if (crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'protocol.json'))).digest('hex') !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }

const sel = JSON.parse(fs.readFileSync(path.join(D, 'h1_selection.json')));
const COSTS = { primary: 0.0005, c0: 0, c025: 0.00025, c10: 0.001 };

function trade(sym, date, mode) { // mode 'long' | 'both'; returns null / {censored} / trade
  const a = dayData.get(date)?.get(sym);
  const e = elig[sym]?.[date];
  if (!a || !e) return { censored: 'no5m' };
  const o0 = O(a, 0), c0 = C(a, 0);
  const dir = c0 > o0 ? 1 : c0 < o0 ? -1 : 0;
  if (dir === 0 || (mode === 'long' && dir === -1)) return null;
  const m1raw = JSON.parse(fs.readFileSync(path.join(D, 'm1', `${date}.json`)))[sym];
  if (!m1raw || m1raw.length < 300) return { censored: 'no1m' };
  const m = new Map(m1raw.map(([j, o, h, l, c]) => [Math.round(j), { o, h, l, c }]));
  const risk = 0.1 * e[2]; // 10% of ATR14
  if (!(risk > 0)) return { censored: 'noatr' };
  const level = dir === 1 ? H(a, 0) : L(a, 0);
  let fill = null, stop = null, exit = null, lastClose = null;
  for (let j = 5; j < 390; j++) {
    const k = m.get(j);
    if (!k) continue;
    lastClose = k.c;
    if (fill === null) {
      const trig = dir === 1 ? k.h >= level : k.l <= level;
      if (!trig) continue;
      fill = dir === 1 ? Math.max(level, k.o) : Math.min(level, k.o);
      stop = dir === 1 ? fill - risk : fill + risk;
      const hit = dir === 1 ? k.l <= stop : k.h >= stop;
      if (hit) { exit = stop; break; } // entry and stop in the same candle: full loss
      continue;
    }
    if (dir === 1) { if (k.o <= stop) { exit = k.o; break; } if (k.l <= stop) { exit = stop; break; } }
    else { if (k.o >= stop) { exit = k.o; break; } if (k.h >= stop) { exit = stop; break; } }
  }
  if (fill === null) return null; // never triggered: no trade
  if (exit === null) exit = lastClose;
  const pnl = dir === 1 ? exit - fill : fill - exit;
  return { date, sym, dir, R: pnl / risk, risk, legs: fill + exit };
}

function runGroup(listKey, mode) {
  const rows = []; const censored = { no5m: 0, no1m: 0, noatr: 0 };
  for (const date of Object.keys(sel).sort()) {
    for (const sym of sel[date][listKey]) {
      const t = trade(sym, date, mode);
      if (!t) continue;
      if (t.censored) { censored[t.censored] += 1; continue; }
      rows.push(t);
    }
  }
  return { rows, censored };
}

function summarize(rows, costRate) {
  const net = rows.map((r) => ({ date: r.date, val: r.R - (costRate * r.legs) / r.risk }));
  const days = S.byDate(net);
  const vals = days.map((d) => d.val);
  const grossSum = rows.reduce((s, r) => s + r.R, 0), costDen = rows.reduce((s, r) => s + r.legs / r.risk, 0);
  const cum = []; let acc = 0; for (const v of vals) { acc += v; cum.push(acc); }
  let peak = 0, mdd = 0; for (const c of cum) { peak = Math.max(peak, c); mdd = Math.min(mdd, c - peak); }
  return {
    trades: rows.length, dates: days.length, hitRate: rows.filter((r) => r.R > 0).length / rows.length,
    meanGrossR: S.mean(rows.map((r) => r.R)), meanNetR: S.mean(net.map((n) => n.val)), meanNetRByDate: S.mean(vals),
    p: S.blockP(vals, P.id + ':H1:' + costRate), byYear: S.byYear(days), breakevenPerSideCost: grossSum / costDen,
    maxDrawdownCumR: mdd, concentrationTop5pctDays: S.concentration(days),
  };
}

const out = { period: DEV };
const topBoth = runGroup('top', 'both'), topLong = runGroup('top', 'long'), ctlLong = runGroup('control', 'long'), ctlBoth = runGroup('control', 'both');
out.reproduction = { description: 'top K(t), long + short, zero cost', ...summarize(topBoth.rows, 0), censored: topBoth.censored };
const pass0 = out.reproduction.meanNetRByDate > 0 && out.reproduction.p < 0.05;
out.reproduction.pass = pass0;
out.controlBoth = { ...summarize(ctlBoth.rows, 0), censored: ctlBoth.censored };
console.log(`H1 reproduction (L+S, cost 0): ${out.reproduction.trades} trades, ${out.reproduction.dates} dates, mean R ${out.reproduction.meanNetRByDate.toFixed(4)}, p ${out.reproduction.p.toFixed(4)} => ${pass0 ? 'PASS' : 'FAIL: published result does not reproduce on these data; long-only cost test not run'}; control (random, L+S, cost 0) mean R ${out.controlBoth.meanNetRByDate.toFixed(4)}`);
if (pass0) {
  out.topLong = {}; out.controlLong = {};
  for (const [name, rate] of Object.entries(COSTS)) { out.topLong[name] = summarize(topLong.rows, rate); out.controlLong[name] = summarize(ctlLong.rows, rate); }
  out.topLong.censored = topLong.censored; out.controlLong.censored = ctlLong.censored;
  const t = out.topLong.primary, c = out.controlLong.primary;
  out.excessOverControl = t.meanNetRByDate - c.meanNetRByDate;
  out.yearsPositive = t.byYear.filter((y) => y.mean > 0).length;
  console.log(`H1 long-only net (0.05%/side): ${t.trades} trades, mean R ${t.meanNetRByDate.toFixed(4)}, p ${t.p.toFixed(4)}, gross R ${t.meanGrossR.toFixed(4)}, control ${c.meanNetRByDate.toFixed(4)}, excess ${out.excessOverControl.toFixed(4)}, years ${t.byYear.map((y) => `${y.year}:${y.mean.toFixed(3)}`).join(' ')}`);
}
out.p = pass0 ? out.topLong.primary.p : 1;
fs.writeFileSync(path.join(__dirname, 'results-h1.json'), JSON.stringify(out, null, 2));

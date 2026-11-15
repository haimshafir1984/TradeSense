// round2: H3 (Noise Area + VWAP on SPY/QQQ) and C2 (trend breakout + short-term reversal entry). Follows protocol.json; refuses to run if changed.
// Usage: node analyze_index.cjs [--locked]   (the locked period is only analysed when asked, after a development pass)
const crypto = require('node:crypto');
const { fs, path } = require('./lib.cjs');
const S = require('./stats.cjs');

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const locked = process.argv.includes('--locked');
const range = locked ? P.common.periods.indexEtfs.locked : P.common.periods.indexEtfs.development;
const inRange = (d) => d >= range[0] && d <= range[1];

// ---------- data ----------
function load(symbol) {
  const dir = path.join(__dirname, 'data', 'index');
  const days = new Map();
  for (const f of fs.readdirSync(dir).sort()) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f)));
    for (const [date, i, o, h, l, c, v] of obj[symbol] || []) {
      let d = days.get(date);
      if (!d) { d = { o: new Float64Array(78).fill(NaN), h: new Float64Array(78).fill(NaN), l: new Float64Array(78).fill(NaN), c: new Float64Array(78).fill(NaN), v: new Float64Array(78).fill(0), n: 0 }; days.set(date, d); }
      d.o[i] = o; d.h[i] = h; d.l[i] = l; d.c[i] = c; d.v[i] = v; d.n += 1;
    }
  }
  // a usable session has the first and the last candle and >= 70 real candles (SIP is dense; early closes drop out)
  const dates = [...days.keys()].filter((k) => { const d = days.get(k); return d.n >= 70 && !Number.isNaN(d.o[0]) && !Number.isNaN(d.c[77]); }).sort();
  return { days, dates };
}

const idxEnd = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ((h * 60 + m) - 570) / 5 - 1; }; // candle ending at HH:MM
const EVAL = []; for (let m = 600; m <= 930; m += 30) EVAL.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); // 10:00 .. 15:30

function vwapUpTo(d, e) { let pv = 0, vv = 0; for (let k = 0; k <= e; k++) { if (Number.isNaN(d.c[k])) continue; pv += ((d.h[k] + d.l[k] + d.c[k]) / 3) * d.v[k]; vv += d.v[k]; } return vv > 0 ? pv / vv : NaN; }

// ---------- H3 ----------
function runH3(symbol, { longShort, costFn, delay = 0 }) {
  const { days, dates } = load(symbol);
  const rows = [];
  for (let n = 14; n < dates.length; n++) {
    const date = dates[n];
    if (!inRange(date)) continue;
    const d = days.get(date), prev = days.get(dates[n - 1]);
    const open = d.o[0], pc = prev.c[77];
    const sigma = {};
    for (const hh of EVAL) {
      const e = idxEnd(hh); let sum = 0, cnt = 0;
      for (let k = 1; k <= 14; k++) { const q = days.get(dates[n - k]); const mv = Math.abs(q.c[e] / q.o[0] - 1); if (Number.isFinite(mv)) { sum += mv; cnt += 1; } }
      sigma[hh] = cnt === 14 ? sum / 14 : NaN;
    }
    let pos = 0, entry = 0, ret = 1, sides = 0, gross = 1; // pos: +1 long, -1 short
    const trade = (px, side) => { // close current position at px
      const cost = costFn(px);
      const g = side === 1 ? px / entry : entry / px;
      gross *= g; ret *= g * (1 - cost) / (1 + costFn(entry)); sides += 2;
    };
    let ok = true;
    for (const hh of EVAL) {
      const e = idxEnd(hh), price = d.c[e], nextOpen = d.o[Math.min(77, e + 1 + delay)];
      if (!(Number.isFinite(price) && Number.isFinite(nextOpen) && Number.isFinite(sigma[hh]))) { if (pos !== 0) { /* cannot evaluate: hold */ } continue; }
      const ub = Math.max(open, pc) * (1 + sigma[hh]), lb = Math.min(open, pc) * (1 - sigma[hh]);
      const vw = vwapUpTo(d, e);
      if (pos === 1 && price < Math.max(ub, vw)) { trade(nextOpen, 1); pos = 0; }
      else if (pos === -1 && price > Math.min(lb, vw)) { trade(nextOpen, -1); pos = 0; }
      if (pos === 0) {
        if (price > ub) { pos = 1; entry = nextOpen; }
        else if (longShort && price < lb) { pos = -1; entry = nextOpen; }
      }
    }
    if (pos !== 0) trade(d.c[77], pos);
    rows.push({ date, val: ret - 1, gross: gross - 1, sides, bhOpen: d.c[77] / d.o[0] - 1 - 2 * costFn(open), bh10: d.c[77] / d.o[6] - 1 - 2 * costFn(open) });
  }
  return rows;
}

function summarizeSeries(rows, key = 'val') {
  const daily = rows.map((r) => r[key]);
  const wd = rows.map((r) => ({ date: r.date, val: r[key] }));
  const sidesAvg = S.mean(rows.map((r) => r.sides || 0));
  return {
    days: rows.length, meanDaily: S.mean(daily), sharpe: S.sharpe(daily), maxDrawdown: S.maxDrawdown(daily), p: S.blockP(daily, P.id + ':' + key),
    concentrationTop5pctDays: S.concentration(wd), byYear: S.byYear(wd), tradesPerDay: sidesAvg / 2,
    grossMeanDaily: key === 'val' ? S.mean(rows.map((r) => r.gross)) : undefined,
    breakevenPerSideCost: key === 'val' && sidesAvg > 0 ? S.mean(rows.map((r) => r.gross)) / sidesAvg : null,
  };
}

// ---------- C2 ----------
function runC2(symbol, cost) {
  const { days, dates } = load(symbol);
  const rows = [];
  const tr = new Map();
  for (let n = 1; n < dates.length; n++) {
    const d = days.get(dates[n]), pc = days.get(dates[n - 1]).c[77];
    let hi = -Infinity, lo = Infinity;
    for (let k = 0; k < 78; k++) { if (!Number.isNaN(d.h[k])) { hi = Math.max(hi, d.h[k]); lo = Math.min(lo, d.l[k]); } }
    tr.set(dates[n], Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  for (let n = 15; n < dates.length; n++) {
    const date = dates[n];
    if (!inRange(date)) continue;
    const d = days.get(date);
    let atr = 0; for (let k = 1; k <= 14; k++) atr += tr.get(dates[n - k]); atr /= 14;
    const open = d.o[0], B = open + 0.5 * atr, stop = open;
    // first 15-minute candle closing above B, candles ending 09:45 .. 15:30
    let e = -1;
    for (let k = 0; k <= 23; k++) { const c15 = d.c[3 * k + 2]; if (Number.isFinite(c15) && c15 > B) { e = 3 * k + 2; break; } }
    const sim = (entryIdx) => {
      if (entryIdx < 0 || entryIdx > 77 || Number.isNaN(d.o[entryIdx])) return null;
      const entry = d.o[entryIdx] * (1 + cost);
      let exit = null;
      for (let m = entryIdx; m <= 77; m++) {
        if (d.l[m] <= stop) { exit = d.o[m] <= stop ? d.o[m] : stop; break; }
      }
      if (exit === null) exit = d.c[77];
      return exit * (1 - cost) / entry - 1;
    };
    const control = e >= 0 ? sim(e + 1) : null;
    let combined = null;
    if (e >= 0) {
      for (let j = e + 1; j <= e + 3 && j <= 76; j++) {
        if (d.c[j] < B) break; // cancelled
        if (d.c[j] < d.o[j]) { combined = sim(j + 1); break; }
      }
    }
    rows.push({ date, control: control ?? 0, combined: combined ?? 0, diff: (combined ?? 0) - (control ?? 0), tradedControl: control !== null, tradedCombined: combined !== null });
  }
  return rows;
}

// ---------- run ----------
const out = { range, locked, H3: {}, C2: {} };
for (const symbol of ['SPY', 'QQQ']) {
  const per = (p) => (px) => p;
  const ours = runH3(symbol, { longShort: false, costFn: per(0.0001) });
  const repro = runH3(symbol, { longShort: true, costFn: (px) => 0.0045 / px });
  const bh = ours;
  out.H3[symbol] = {
    longOnlyOurCost: summarizeSeries(ours),
    reproductionLongShortPaperCost: summarizeSeries(repro),
    descriptiveLongOnlyOneCandleLater: summarizeSeries(runH3(symbol, { longShort: false, costFn: per(0.0001), delay: 1 })),
    descriptiveLongOnlyCost2bp: summarizeSeries(runH3(symbol, { longShort: false, costFn: per(0.0002) })),
    controlBuyHoldOpenClose: { meanDaily: S.mean(bh.map((r) => r.bhOpen)), sharpe: S.sharpe(bh.map((r) => r.bhOpen)), maxDrawdown: S.maxDrawdown(bh.map((r) => r.bhOpen)) },
    controlBuyHold10to16: { meanDaily: S.mean(bh.map((r) => r.bh10)), sharpe: S.sharpe(bh.map((r) => r.bh10)), maxDrawdown: S.maxDrawdown(bh.map((r) => r.bh10)) },
  };
  const c2 = runC2(symbol, 0.0001);
  const wd = (k) => c2.map((r) => ({ date: r.date, val: r[k] }));
  out.C2[symbol] = {
    days: c2.length,
    control: { meanDaily: S.mean(c2.map((r) => r.control)), sharpe: S.sharpe(c2.map((r) => r.control)), tradeDays: c2.filter((r) => r.tradedControl).length, maxDrawdown: S.maxDrawdown(c2.map((r) => r.control)), p: S.blockP(c2.map((r) => r.control), P.id + ':c2control'), byYear: S.byYear(wd('control')) },
    combined: { meanDaily: S.mean(c2.map((r) => r.combined)), sharpe: S.sharpe(c2.map((r) => r.combined)), tradeDays: c2.filter((r) => r.tradedCombined).length, maxDrawdown: S.maxDrawdown(c2.map((r) => r.combined)), p: S.blockP(c2.map((r) => r.combined), P.id + ':c2combined'), byYear: S.byYear(wd('combined')), concentrationTop5pctDays: S.concentration(wd('combined')) },
    difference: { meanDaily: S.mean(c2.map((r) => r.diff)), p: S.blockP(c2.map((r) => r.diff), P.id + ':c2diff'), byYear: S.byYear(wd('diff')) },
  };
}
fs.writeFileSync(path.join(__dirname, locked ? 'results-index-locked.json' : 'results-index.json'), JSON.stringify(out, null, 2));
const f = (x) => S.pct(x, 4);
for (const symbol of ['SPY', 'QQQ']) {
  const h = out.H3[symbol], c = out.C2[symbol];
  console.log(`H3 ${symbol} ${range[0]}..${range[1]}: long-only mean/day ${f(h.longOnlyOurCost.meanDaily)} (gross ${f(h.longOnlyOurCost.grossMeanDaily)}) Sharpe ${h.longOnlyOurCost.sharpe?.toFixed(2)} p ${h.longOnlyOurCost.p.toFixed(4)} | repro L/S mean/day ${f(h.reproductionLongShortPaperCost.meanDaily)} Sharpe ${h.reproductionLongShortPaperCost.sharpe?.toFixed(2)} p ${h.reproductionLongShortPaperCost.p.toFixed(4)} | B&H open-close Sharpe ${h.controlBuyHoldOpenClose.sharpe?.toFixed(2)}, 10-close ${h.controlBuyHold10to16.sharpe?.toFixed(2)}`);
  console.log(`   robustness (descriptive): one candle later ${f(h.descriptiveLongOnlyOneCandleLater.meanDaily)}/day, cost 2bp/side ${f(h.descriptiveLongOnlyCost2bp.meanDaily)}/day, breakeven cost/side ${f(h.longOnlyOurCost.breakevenPerSideCost)}, max DD ${S.pct(h.longOnlyOurCost.maxDrawdown,1)}, years ${h.longOnlyOurCost.byYear.map((y) => y.year + ':' + f(y.mean)).join(' ')}`);
  console.log(`C2 ${symbol}: control mean/day ${f(c.control.meanDaily)} (${c.control.tradeDays} trade days), combined ${f(c.combined.meanDaily)} (${c.combined.tradeDays}), diff ${f(c.difference.meanDaily)} p ${c.difference.p.toFixed(4)}`);
}

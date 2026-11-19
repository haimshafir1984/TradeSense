// cameron-1: gap-and-go on the 400-stock sample, development period only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R2 = path.join(__dirname, '..', 'round2');
const S = require(path.join(R2, 'stats.cjs'));
const { load5, O, H, L, C, V, D } = require(path.join(R2, 'load5.cjs'));

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== reg.files['protocol.json'].sha256) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const DEV = P.periods.development;

const { dayData, sessions } = load5();
const dailyS = JSON.parse(fs.readFileSync(path.join(D, 'daily_S.json')));
const dailyBy = new Map();
for (const [sym, arr] of Object.entries(dailyS)) dailyBy.set(sym, new Map(arr.map(([date, o, h, l, c, v]) => [date, { o, h, l, c, v }])));

function avgVol20(sym, i) { // mean daily volume of the 20 sessions before session i
  const m = dailyBy.get(sym); if (!m) return null;
  let s = 0;
  for (let k = 1; k <= 20; k++) { const b = m.get(sessions[i - k]); if (!b || !(b.v > 0)) return null; s += b.v; }
  return s / 20;
}

function trade(a, sym, i, group) { // returns null when no signal / trade, otherwise {R, risk, legs, entryCandleStop}
  const prev = dailyBy.get(sym)?.get(sessions[i - 1]);
  if (!prev || !(prev.c > 0)) return null;
  const o0 = O(a, 0), h0 = H(a, 0), l0 = L(a, 0), c0 = C(a, 0);
  if (!(o0 > 0)) return null;
  const gap = o0 / prev.c - 1;
  if (group === 'gap' ? !(gap >= 0.05) : !(Math.abs(gap) < 0.01)) return null;
  if (!(c0 > o0)) return null;
  const av = avgVol20(sym, i); if (!av) return null;
  let cum = V(a, 0) > 0 ? V(a, 0) : 0, sig = -1;
  for (let j = 1; j <= 11; j++) {
    const c = C(a, j); if (Number.isNaN(c)) continue;
    cum += V(a, j) > 0 ? V(a, j) : 0;
    if (c > h0) { sig = j; break; }
  }
  if (sig < 0) return null;
  const sc = C(a, sig);
  if (!(sc >= 2 && sc <= 20)) return null;
  const rvol = cum / (av * (((sig + 1) * 5) / 390));
  if (!(rvol >= 2)) return null;
  const stop = l0, risk = sc - stop;
  if (!(risk > 0) || risk / sc > 0.08) return null;
  const target = sc + 2 * risk;
  const e = sig + 1; if (e > 77 || Number.isNaN(O(a, e))) return null;
  const fill = O(a, e);
  let exit = null, entryStop = false;
  for (let m = e; m <= 77; m++) {
    if (Number.isNaN(L(a, m))) continue;
    if (O(a, m) <= stop) { exit = O(a, m); if (m === e) entryStop = true; break; }
    if (L(a, m) <= stop) { exit = stop; if (m === e) entryStop = true; break; }
    if (H(a, m) >= target) { exit = O(a, m) >= target ? O(a, m) : target; break; }
  }
  if (exit === null) { exit = C(a, 77); if (!(exit > 0)) { for (let m = 77; m > e; m--) if (C(a, m) > 0) { exit = C(a, m); break; } } if (!(exit > 0)) return null; }
  return { R: (exit - fill) / risk, risk, legs: fill + exit, entryStop };
}

const rows = { gap: [], ctrl: [] };
for (let i = 21; i < sessions.length; i++) {
  const date = sessions[i];
  if (date < DEV[0] || date > DEV[1]) continue;
  for (const [sym, a] of dayData.get(date)) for (const group of ['gap', 'ctrl']) { const t = trade(a, sym, i, group); if (t) rows[group].push({ date, sym, ...t }); }
}

const net = (r, rate) => r.R - (rate * r.legs) / r.risk;
function summarize(list, rate = P.costs.primaryPerSide) {
  const n = list.map((r) => ({ date: r.date, val: net(r, rate) }));
  const days = S.byDate(n), vals = days.map((d) => d.val);
  let acc = 0, pk = 0, mdd = 0; for (const v of vals) { acc += v; pk = Math.max(pk, acc); mdd = Math.min(mdd, acc - pk); }
  const gross = list.reduce((s, r) => s + r.R, 0), den = list.reduce((s, r) => s + r.legs / r.risk, 0);
  return { trades: list.length, dates: days.length, grossR: S.mean(list.map((r) => r.R)), netR: S.mean(list.map((r) => net(r, rate))), netRByDate: S.mean(vals), hit: list.filter((r) => r.R > 0).length / Math.max(1, list.length), p: S.blockP(vals, P.id + ':' + rate + ':' + list.length), breakevenPerSide: gross / den, maxDrawdownCumR: mdd, concentrationTop5pctDates: S.concentration(days), byYear: S.byYear(days), worstR: Math.min(...list.map((r) => r.R)), entryCandleStopShare: list.filter((r) => r.entryStop).length / Math.max(1, list.length) };
}
const out = { period: DEV, gap: summarize(rows.gap), control: summarize(rows.ctrl), sensitivity: {} };
for (const rate of P.costs.sensitivityPerSide) out.sensitivity[rate] = S.mean(rows.gap.map((r) => net(r, rate)));
const gDay = new Map(S.byDate(rows.gap.map((r) => ({ date: r.date, val: net(r, P.costs.primaryPerSide) }))).map((d) => [d.date, d.val]));
const cDay = new Map(S.byDate(rows.ctrl.map((r) => ({ date: r.date, val: net(r, P.costs.primaryPerSide) }))).map((d) => [d.date, d.val]));
const diffs = [...gDay.keys()].filter((k) => cDay.has(k)).sort().map((k) => gDay.get(k) - cDay.get(k));
out.excessOverControl = { dates: diffs.length, mean: S.mean(diffs), p: S.blockP(diffs, P.id + ':excess') };
const yearsPos = out.gap.byYear.filter((y) => y.mean > 0).length;
out.pass = out.gap.p < 0.05 && out.gap.netRByDate > 0 && out.gap.trades >= 100 && yearsPos >= 2 && out.excessOverControl.mean > 0;
fs.writeFileSync(path.join(__dirname, 'results-dev.json'), JSON.stringify(out, null, 2));
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const g = out.gap, c = out.control;
console.log(`GAP: trades ${g.trades} on ${g.dates} dates; gross R ${f(g.grossR)} net R ${f(g.netR)} (by date ${f(g.netRByDate)}) p ${f(g.p, 4)} hit ${f(g.hit * 100, 1)}% breakeven ${f(g.breakevenPerSide * 100, 3)}%/side; entry-candle stops ${f(g.entryCandleStopShare * 100, 0)}%; worst ${f(g.worstR)}R; years ${g.byYear.map((y) => `${y.year}:${f(y.mean)}`).join(' ')}`);
console.log(`CTRL(no gap): trades ${c.trades} on ${c.dates} dates; gross R ${f(c.grossR)} net R ${f(c.netR)} p ${f(c.p, 4)} hit ${f(c.hit * 100, 1)}%`);
console.log(`excess over control ${f(out.excessOverControl.mean)} (p ${f(out.excessOverControl.p, 3)}, ${out.excessOverControl.dates} dates); sensitivity ${JSON.stringify(out.sensitivity)}; pass=${out.pass}`);

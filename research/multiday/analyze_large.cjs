// multiday-1: 5-day holding of signalled stocks on an Alpaca-like universe. Development period only (locked period is gated).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../round2/stats.cjs');

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration-large.json')));
const buf = fs.readFileSync(path.join(__dirname, 'protocol-large.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== reg.files['protocol-large.json'].sha256) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const DEV = P.periods.development;
const DAILY = path.join(__dirname, '..', 'round2', 'data', 'daily');
const COST = P.costs.primaryRoundTrip;
const dayDiff = (a, b) => (Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000;

const perDate = new Map(); // date -> rows of eligible symbol-days
const stats = { symbols: 0, eligibleDays: 0, censoredGap: 0, delistedExit: 0 };
for (const f of fs.readdirSync(DAILY).sort()) {
  const shard = JSON.parse(fs.readFileSync(path.join(DAILY, f)));
  for (const [sym, a] of Object.entries(shard)) {
    stats.symbols += 1;
    const n = a.length; if (n < 30) continue;
    const lastDate = a[n - 1][0];
    const delisted = lastDate < '2023-12-15';
    for (let i = 20; i < n - 1; i++) {
      const [d, o, h, l, c, v] = a[i];
      if (d < DEV[0] || d > DEV[1] || !(c >= P.universe.minPrice)) continue;
      let adv = 0, vol = 0, vs = 0, hi = 0, ok = true;
      for (let k = i - 19; k <= i; k++) { const q = a[k]; if (!(q[4] > 0 && q[5] >= 0 && q[2] >= q[3])) { ok = false; break; } adv += q[4] * q[5]; vol += (q[2] - q[3]) / q[4]; }
      if (!ok) continue;
      adv /= 20; vol /= 20;
      if (adv < P.universe.adv20Min) continue;
      for (let k = i - 20; k <= i - 1; k++) { vs += a[k][5]; if (a[k][2] > hi) hi = a[k][2]; }
      // the 20 previous sessions (t-20..t-1) for volume and highs
      const vm = vs / 20; if (!(vm > 0)) continue;
      const prevClose = a[i - 1][4]; if (!(prevClose > 0)) continue;
      const ret = c / prevClose - 1, volRatio = v / vm, range = h - l;
      const topQuarter = range > 0 && (c - l) / range >= 0.75;
      let flags = 0;
      if (ret >= 0.04 && volRatio >= 2 && topQuarter) flags |= 1;
      if (ret >= 0.08 && volRatio >= 2 && topQuarter) flags |= 8;
      if (ret <= -0.04 && volRatio >= 2) flags |= 2;
      if (ret <= -0.08 && volRatio >= 2) flags |= 16;
      if (c > hi && volRatio >= 1.5 && ret >= 0.015) flags |= 4;
      if (c > hi && volRatio >= 1.5 && ret >= 0.03) flags |= 32;
      // forward outcomes
      let i5 = i + 5, i3 = i + 3, i1 = i + 1, clamped = false;
      if (i5 > n - 1) { if (!delisted) continue; i5 = n - 1; i3 = Math.min(i3, n - 1); clamped = true; }
      if (dayDiff(d, a[i5][0]) > 11) { stats.censoredGap += 1; continue; }
      const entry = a[i + 1][1]; if (!(entry > 0)) continue;
      if (clamped) stats.delistedExit += 1;
      const row = { sym, vol, volRatio, ret, flags, r5: a[i5][4] / entry - 1, r3: a[i3][4] / entry - 1, r1: a[i1][4] / entry - 1, gap: entry / c - 1 };
      (perDate.get(d) || perDate.set(d, []).get(d)).push(row);
      stats.eligibleDays += 1;
    }
  }
}

const seedOrder = (date, sym) => crypto.createHash('sha256').update(`${P.id}|${date}|${sym}`).digest('hex');
const days = [...perDate.keys()].sort();
const groups = { M1: [], M2: [], M3: [], D1: [], D2: [], D3: [], CTRL: [] }; // rows with date
const rankBy = { M1: (a, b) => b.volRatio - a.volRatio, M2: (a, b) => a.ret - b.ret, M3: (a, b) => b.volRatio - a.volRatio, D1: (a, b) => b.volRatio - a.volRatio, D2: (a, b) => a.ret - b.ret, D3: (a, b) => b.volRatio - a.volRatio };
for (const d of days) {
  const top = perDate.get(d);
  if (top.length < 50) continue;
  groups.CTRL.push(...[...top].sort((a, b) => (seedOrder(d, a.sym) < seedOrder(d, b.sym) ? -1 : 1)).slice(0, 5).map((r) => ({ ...r, date: d })));
  for (const [name, bit] of [['M1', 1], ['M2', 2], ['M3', 4], ['D1', 8], ['D2', 16], ['D3', 32]]) groups[name].push(...top.filter((r) => r.flags & bit).sort(rankBy[name]).slice(0, 5).map((r) => ({ ...r, date: d })));
}

const net = (r, h) => r[h] - COST;
const perDateMean = (rows, h) => new Map(S.byDate(rows.map((r) => ({ date: r.date, val: net(r, h) }))).map((x) => [x.date, x.val]));
function summarize(name, h = 'r5') {
  const rows = groups[name], ctrl = perDateMean(groups.CTRL, h), picks = S.byDate(rows.map((r) => ({ date: r.date, val: net(r, h) })));
  const exDays = picks.filter((x) => ctrl.has(x.date)).map((x) => ({ date: x.date, val: x.val - ctrl.get(x.date) }));
  const vals = picks.map((x) => x.val);
  const grossMean = S.mean(rows.map((r) => r[h])), netMean = S.mean(rows.map((r) => net(r, h)));
  let acc = 0, pk = 0, mdd = 0; for (const x of picks) { acc += x.val; pk = Math.max(pk, acc); mdd = Math.min(mdd, acc - pk); }
  return {
    trades: rows.length, dates: picks.length, grossMean, netMean, controlNetMean: S.mean(groups.CTRL.map((r) => net(r, h))),
    excess: S.mean(exDays.map((x) => x.val)), p: S.blockP(exDays.map((x) => x.val), `${P.id}:${name}:${h}`), hit: rows.filter((r) => net(r, h) > 0).length / Math.max(1, rows.length),
    breakevenRoundTrip: grossMean, maxDrawdownCumPerDateMean: mdd, concentrationTop5pctDates: S.concentration(picks), byYear: S.byYear(picks),
    gapAbove10pctShare: rows.filter((r) => r.gap > 0.10).length / Math.max(1, rows.length), worstTrade: Math.min(...rows.map((r) => net(r, h))),
    sensitivity: { cost0_1: S.mean(rows.map((r) => r[h] - 0.001)), cost0_5: S.mean(rows.map((r) => r[h] - 0.005)) },
  };
}

for (const n of ['M1','M2','M3']) { const x = groups[n].map((r) => r.r5).sort((a, b) => a - b); const tr = x.filter((v) => Math.abs(v) < 0.5); console.log(n, 'gross median', (x[x.length >> 1] * 100).toFixed(2) + '%', 'trimmed mean(|r|<50%)', (S.mean(tr) * 100).toFixed(2) + '%', 'n', x.length); }
const out = { period: DEV, load: stats, perHypothesis: {}, descriptiveHorizons: {} };
for (const name of ['M1', 'M2', 'M3']) {
  out.perHypothesis[name] = summarize(name, 'r5');
  out.descriptiveHorizons[name] = { r1: { net: S.mean(groups[name].map((r) => net(r, 'r1'))), excess: summarize(name, 'r1').excess }, r3: { net: S.mean(groups[name].map((r) => net(r, 'r3'))), excess: summarize(name, 'r3').excess } };
}
for (const name of ['D1', 'D2', 'D3']) if (groups[name].length) out.descriptiveOriginalThresholds = { ...(out.descriptiveOriginalThresholds || {}), [name]: (({ trades, netMean, excess }) => ({ trades, netMean, excess }))(summarize(name, 'r5')) };
const order = Object.entries(out.perHypothesis).sort((a, b) => a[1].p - b[1].p); // Holm
let prev = 0; order.forEach(([k, v], i) => { const adj = Math.min(1, v.p * (order.length - i)); prev = Math.max(prev, adj); out.perHypothesis[k].holm = prev; });
for (const [k, v] of Object.entries(out.perHypothesis)) {
  const yearsPos = v.byYear.filter((y) => y.mean > 0).length;
  v.pass = v.holm < 0.05 && v.excess > 0 && v.netMean > 0 && v.trades >= 100 && yearsPos >= 2;
}
out.controlNetMean = S.mean(groups.CTRL.map((r) => net(r, 'r5')));
{ const x = groups.CTRL.map((r) => r.r5).sort((a, b) => a - b); const tr = x.filter((v) => Math.abs(v) < 1);
  out.controlDescriptive = { n: x.length, grossMean: S.mean(x), grossMedian: x[x.length >> 1], grossTrimmedMean: S.mean(tr), share5dayDropOver50pct: x.filter((v) => v < -0.5).length / x.length, byYear: S.byYear(S.byDate(groups.CTRL.map((r) => ({ date: r.date, val: r.r5 })))) }; }
fs.writeFileSync(path.join(__dirname, 'results-large-dev.json'), JSON.stringify(out, null, 2));
const f = (x) => S.pct(x, 2);
console.log('control (top-150 volatile, random 5/day) gross: ' + JSON.stringify({ mean: f(out.controlDescriptive.grossMean), median: f(out.controlDescriptive.grossMedian), trimmed: f(out.controlDescriptive.grossTrimmedMean), drop50: f(out.controlDescriptive.share5dayDropOver50pct), years: out.controlDescriptive.byYear.map((y) => y.year + ':' + f(y.mean)) }));
console.log('descriptive original thresholds (not tested): ' + JSON.stringify(out.descriptiveOriginalThresholds));
console.log(`loaded symbols ${stats.symbols}, eligible symbol-days ${stats.eligibleDays}, censored(gap) ${stats.censoredGap}, delisted exits ${stats.delistedExit}; control net ${f(out.controlNetMean)}`);
for (const [k, v] of Object.entries(out.perHypothesis)) console.log(`${k}: trades ${v.trades} dates ${v.dates} gross ${f(v.grossMean)} net ${f(v.netMean)} control ${f(v.controlNetMean)} excess ${f(v.excess)} p ${v.p.toFixed(3)} holm ${v.holm.toFixed(3)} hit ${(v.hit * 100).toFixed(1)}% gap>10% ${(v.gapAbove10pctShare * 100).toFixed(0)}% worst ${f(v.worstTrade)} years ${v.byYear.map((y) => `${y.year}:${f(y.mean)}`).join(' ')} => ${v.pass ? 'PASS' : 'fail'}`);

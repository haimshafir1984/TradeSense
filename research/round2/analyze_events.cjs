// round2 H5 (guidance raise + Stocks in Play + breakout) and H6 (second day after a positive event). Development only.
// Needs data/news_precision.json {real, matches} (the manual 40-headline precision check); below 28/40 both are NOT TESTABLE.
const crypto = require('node:crypto');
const { fs, path } = require('./lib.cjs');
const S = require('./stats.cjs');
const { load5, O, H, L, C, V, D } = require('./load5.cjs');

const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
if (crypto.createHash('sha256').update(buf).digest('hex') !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(buf);
const DEV = P.common.periods.stocks.development;

const prec = JSON.parse(fs.readFileSync(path.join(D, 'news_precision.json')));
if (prec.real < 28) {
  const out = { testable: false, reason: `precision ${prec.real}/${prec.matches} below 28/40`, H5: { p: 1 }, H6: { p: 1 } };
  fs.writeFileSync(path.join(__dirname, 'results-events.json'), JSON.stringify(out, null, 2));
  console.log('H5/H6 NOT TESTABLE:', out.reason);
  process.exit(0);
}

const { dayData, sessions } = load5();
const elig = JSON.parse(fs.readFileSync(path.join(D, 'elig_S.json')));
const dailyS = JSON.parse(fs.readFileSync(path.join(D, 'daily_S.json')));
const dailyBy = new Map(); // sym -> Map date -> {o,h,l,c,v}
for (const [sym, arr] of Object.entries(dailyS)) dailyBy.set(sym, new Map(arr.map(([date, o, h, l, c, v]) => [date, { o, h, l, c, v }])));
const dailyDates = (sym) => [...dailyBy.get(sym).keys()].sort();

const P1 = /\b(raises?|raised|lifts?|lifted|boosts?|boosted|increases?|increased|hikes?|hiked)\b[^.]{0,80}\b(guidance|outlook|forecast)\b/i;
const P2 = /\b(guidance|outlook|forecast)\b[^.]{0,40}\b(raised|boosted|lifted|increased)\b/i;
const EXCL = /(price target|\bPT\b|analyst|upgrade|downgrade|rating|initiates|maintains|reiterates)/i;
const isEvent = (h) => (P1.test(h) || P2.test(h)) && !EXCL.test(h);

const events = new Map(); // date -> Set(symbol)
for (const f of fs.readdirSync(path.join(D, 'news'))) {
  const date = f.slice(0, 10);
  const set = new Set();
  for (const a of JSON.parse(fs.readFileSync(path.join(D, 'news', f)))) if (a.n <= 2 && isEvent(a.h)) for (const s of a.s) set.add(s);
  events.set(date, set);
}

const COST = 0.0005;
const relVol20 = (i, sym) => {
  const a = dayData.get(sessions[i])?.get(sym); if (!a || !(V(a, 0) > 0)) return null;
  let sum = 0; for (let k = 1; k <= 20; k++) { const b = dayData.get(sessions[i - k])?.get(sym); const v = b ? V(b, 0) : NaN; if (!(v > 0)) return null; sum += v; }
  return V(a, 0) / (sum / 20);
};

function breakoutTrade(a, date, sym) { // H5 mechanics
  const o0 = O(a, 0), c0 = C(a, 0);
  if (!(c0 > o0)) return null;
  const level = H(a, 0), stop = L(a, 0);
  let entryIdx = -1;
  for (let j = 1; j <= 11; j++) if (C(a, j) > level) { entryIdx = j + 1; break; }
  if (entryIdx < 0 || entryIdx > 77) return null;
  const entry = O(a, entryIdx);
  if (!(entry > stop)) return null;
  const risk = entry - stop; let exit = null;
  for (let m = entryIdx; m <= 77; m++) { if (Number.isNaN(L(a, m))) continue; if (L(a, m) <= stop) { exit = O(a, m) <= stop ? O(a, m) : stop; break; } }
  if (exit === null) { exit = C(a, 77); if (!(exit > 0)) return null; }
  return { date, sym, risk, R: (exit - entry) / risk, net: (exit - entry) / risk - (COST * (entry + exit)) / risk };
}

function secondDayTrade(i, sym, a) { // H6 mechanics; null when the pattern does not form
  const d1 = dailyBy.get(sym).get(sessions[i - 1]), d2 = dailyBy.get(sym).get(sessions[i - 2]);
  if (!d1 || !d2) return undefined;
  return { d1, d2 };
}

function groupDiffP(A, B, tag) { // statistic = mean(A) - mean(B), resampling dates in blocks
  const dates = [...new Set([...A, ...B].map((r) => r.date))].sort();
  const perDate = new Map(dates.map((d) => [d, { a: [], b: [] }]));
  for (const r of A) perDate.get(r.date).a.push(r.net);
  for (const r of B) perDate.get(r.date).b.push(r.net);
  const list = dates.map((d) => perDate.get(d));
  const N = list.length; if (N < 20) return { p: 1, diff: NaN };
  const diffOf = (gs) => S.mean(gs.flatMap((g) => g.a)) - S.mean(gs.flatMap((g) => g.b));
  const rand = S.rng(P.id + ':' + tag); let le = 0;
  for (let k = 0; k < 2000; k++) { const sample = []; while (sample.length < N) { const s = Math.floor(rand() * N); for (let b = 0; b < 20 && sample.length < N; b++) sample.push(list[(s + b) % N]); } const d = diffOf(sample); if (!(d > 0)) le += 1; }
  return { p: Math.max(le / 2000, 1 / 2000), diff: diffOf(list) };
}

const rowsH5 = { EVENT_ONLY: [], VOLUME_ONLY: [], COMBINED: [] };
const rowsH6 = { event: [], control: [] };
let eventStockDays = 0, eventWithRv2 = 0;
for (let i = 21; i < sessions.length; i++) {
  const date = sessions[i];
  if (date < DEV[0] || date > DEV[1]) continue;
  const today = dayData.get(date);
  const ev = events.get(date) || new Set();
  const cands = [];
  for (const [sym, a] of today) {
    if (!elig[sym]?.[date]?.[1]) continue;
    const rv = relVol20(i, sym);
    if (rv === null) continue;
    cands.push({ sym, a, rv, event: ev.has(sym) });
  }
  const top5 = (list) => [...list].sort((x, y) => y.rv - x.rv).slice(0, 5);
  const vol = top5(cands.filter((c) => c.rv >= 2)), comb = top5(cands.filter((c) => c.event && c.rv >= 2));
  eventStockDays += cands.filter((c) => c.event).length; eventWithRv2 += comb.length;
  for (const [name, list] of [['VOLUME_ONLY', vol], ['COMBINED', comb], ['EVENT_ONLY', cands.filter((c) => c.event)]]) for (const c of list) { const t = breakoutTrade(c.a, date, c.sym); if (t) rowsH5[name].push(t); }

  // H6: day t-1 positive event + strong close above the high of day t-2
  const evPrev = events.get(sessions[i - 1]) || new Set();
  for (const [sym, a] of today) {
    if (!elig[sym]?.[date]?.[1]) continue;
    const dm = dailyBy.get(sym); const d1 = dm.get(sessions[i - 1]), d2 = dm.get(sessions[i - 2]), d3 = dm.get(sessions[i - 3]);
    if (!d1 || !d2 || !d3) continue;
    let vs = 0, ok = true; for (let k = 2; k <= 21; k++) { const q = dm.get(sessions[i - k]); if (!q) { ok = false; break; } vs += q.v; }
    if (!ok) continue;
    const cond = d1.c / d2.c - 1 >= 0.05 && d1.v >= 2 * (vs / 20) && d1.h > d1.l && (d1.c - d1.l) / (d1.h - d1.l) >= 0.75 && d1.c > d2.h;
    if (!cond) continue;
    const Llevel = d2.h, target = d1.h;
    if (!(O(a, 0) > Llevel)) continue;
    let test = -1;
    for (let j = 0; j <= 17; j++) if (L(a, j) <= Llevel && C(a, j) > Llevel) { test = j; break; }
    if (test < 0) continue;
    let entryIdx = -1;
    for (let m = test + 1; m <= 76; m++) if (C(a, m) > H(a, test)) { entryIdx = m + 1; break; }
    if (entryIdx < 0) continue;
    const entry = O(a, entryIdx), stop = L(a, test);
    if (!(entry > stop) || (target - entry) / (entry - stop) < 2) continue;
    const risk = entry - stop; let exit = null;
    for (let m = entryIdx; m <= 77; m++) {
      if (Number.isNaN(L(a, m))) continue;
      if (L(a, m) <= stop) { exit = O(a, m) <= stop ? O(a, m) : stop; break; }
      if (H(a, m) >= target) { exit = O(a, m) >= target ? O(a, m) : target; break; }
    }
    if (exit === null) exit = C(a, 77);
    const R = (exit - entry) / risk;
    (evPrev.has(sym) ? rowsH6.event : rowsH6.control).push({ date, sym, R, net: R - (COST * (entry + exit)) / risk });
  }
}

const sum = (rows) => ({ trades: rows.length, dates: new Set(rows.map((r) => r.date)).size, meanGrossR: S.mean(rows.map((r) => r.R)), meanNetR: S.mean(rows.map((r) => r.net)), hit: rows.filter((r) => r.R > 0).length / Math.max(1, rows.length), byYear: S.byYear(rows.map((r) => ({ date: r.date, val: r.net }))) });
const out = { testable: true, precision: prec, eventStockDays, eventWithRv2 };
out.H5 = { groups: Object.fromEntries(Object.entries(rowsH5).map(([k, v]) => [k, sum(v)])) };
const d5 = groupDiffP(rowsH5.COMBINED, rowsH5.VOLUME_ONLY, 'H5');
out.H5.statistic = { combinedMinusVolumeOnly: d5.diff, p: rowsH5.COMBINED.length >= 100 ? d5.p : 1, underpowered: rowsH5.COMBINED.length < 100 };
out.H5.p = out.H5.statistic.p;
out.H6 = { groups: { event: sum(rowsH6.event), control: sum(rowsH6.control) } };
const d6 = groupDiffP(rowsH6.event, rowsH6.control, 'H6');
out.H6.statistic = { eventMinusControl: d6.diff, p: rowsH6.event.length >= 100 ? d6.p : 1, underpowered: rowsH6.event.length < 100 };
out.H6.p = out.H6.statistic.p;
fs.writeFileSync(path.join(__dirname, 'results-events.json'), JSON.stringify(out, null, 2));
console.log(`events: stock-days with a guidance-raise headline ${eventStockDays}; with relVol>=2 ${eventWithRv2}`);
for (const [k, v] of Object.entries(out.H5.groups)) console.log(`H5 ${k}: ${v.trades} trades on ${v.dates} dates, mean net R ${v.meanNetR?.toFixed?.(3)}, gross ${v.meanGrossR?.toFixed?.(3)}`);
console.log(`H5 statistic COMBINED-VOLUME_ONLY ${out.H5.statistic.combinedMinusVolumeOnly?.toFixed?.(3)} p ${out.H5.statistic.p.toFixed(3)} ${out.H5.statistic.underpowered ? '(underpowered)' : ''}`);
for (const [k, v] of Object.entries(out.H6.groups)) console.log(`H6 ${k}: ${v.trades} trades on ${v.dates} dates, mean net R ${v.meanNetR?.toFixed?.(3)}`);
console.log(`H6 statistic event-control ${out.H6.statistic.eventMinusControl?.toFixed?.(3)} p ${out.H6.statistic.p.toFixed(3)} ${out.H6.statistic.underpowered ? '(underpowered)' : ''}`);

// round2 H2: late-day strength, entry at ~15:55, exit at the next session's open (Fable H2). Development period only.
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

const { dayData, sessions } = load5();
const elig = JSON.parse(fs.readFileSync(path.join(D, 'elig_S.json')));
const counts = JSON.parse(fs.readFileSync(path.join(D, 'eligibility_counts.json')));
const dailyS = JSON.parse(fs.readFileSync(path.join(D, 'daily_S.json')));
const closeBy = new Map(); // sym -> Map date -> official daily close
for (const [sym, arr] of Object.entries(dailyS)) closeBy.set(sym, new Map(arr.map((b) => [b[0], b[4]])));

const ENTRY = 0.0005, EXIT = 0.0010, ROUND = ENTRY + EXIT;
const seedOrder = (tag, date, sym) => crypto.createHash('sha256').update(`round2-1-h2-${tag}|${date}|${sym}`).digest('hex');

function features(i, sym) { // evaluation of one stock on session i; null when data are missing
  const date = sessions[i], a = dayData.get(date)?.get(sym);
  if (!a || i < 20 || i + 1 >= sessions.length) return null;
  const nextA = dayData.get(sessions[i + 1])?.get(sym);
  const prevClose = closeBy.get(sym)?.get(sessions[i - 1]);
  if (!nextA || !(prevClose > 0)) return null;
  const price = C(a, 75), entry = C(a, 76), exit = O(nextA, 0);
  if (!(price > 0 && entry > 0 && exit > 0)) return null;
  let hi = -Infinity, lo = Infinity, pv = 0, vv = 0, cum = 0;
  for (let k = 0; k <= 75; k++) {
    const h = H(a, k), l = L(a, k), c = C(a, k), v = V(a, k);
    if (Number.isNaN(c)) continue;
    hi = Math.max(hi, h); lo = Math.min(lo, l); pv += ((h + l + c) / 3) * v; vv += v; cum += v;
  }
  if (!(hi > lo) || !(vv > 0)) return null;
  let sum = 0;
  for (let k = 1; k <= 20; k++) {
    const b = dayData.get(sessions[i - k])?.get(sym); if (!b) return null;
    let cv = 0; for (let q = 0; q <= 75; q++) { const v = V(b, q); if (v > 0) cv += v; }
    if (!(cv > 0)) return null;
    sum += cv;
  }
  const nextClose = C(nextA, 77), nextOpen = O(nextA, 0);
  return { date, sym, price, prevClose, up: price / prevClose - 1, range: (price - lo) / (hi - lo), aboveVwap: price > pv / vv, volRatio: cum / (sum / 20), entry, exit, gap: exit / entry - 1, nextDay: nextClose / nextOpen - 1 };
}

const byDay = []; // [{date, K, signals[], all[] }]
const censoredCount = { missing: 0 };
for (let i = 0; i < sessions.length; i++) {
  const date = sessions[i];
  if (date < DEV[0] || date > DEV[1]) continue;
  const all = [];
  for (const [sym] of dayData.get(date)) {
    const e = elig[sym]?.[date];
    if (!e || !e[1]) continue;
    const f = features(i, sym);
    if (!f) { censoredCount.missing += 1; continue; }
    all.push(f);
  }
  let nS2 = 0; for (const [sym] of dayData.get(date)) if (elig[sym]?.[date]?.[1]) nS2 += 1;
  const nM = counts[date]?.h2 || 0;
  const K = Math.max(1, Math.round(10 * nS2 / Math.max(1, nM)));
  const signals = all.filter((f) => f.up >= 0.02 && f.aboveVwap && f.range >= 0.75 && f.volRatio >= 2).sort((a, b) => b.volRatio - a.volRatio);
  const weak = all.filter((f) => f.up >= 0.02 && f.range < 0.5);
  byDay.push({ date, K, signals, weak, all });
}

const net = (f) => f.gap - ROUND;
const rowsOf = (pick) => byDay.flatMap((d) => pick(d).map((f) => ({ date: d.date, val: net(f), gross: f.gap, gapAbs: Math.abs(f.gap) })));
const head = rowsOf((d) => d.signals.slice(0, d.K));
const allSignals = rowsOf((d) => d.signals);
const c1 = rowsOf((d) => [...d.all].sort((a, b) => (seedOrder('c1', d.date, a.sym) < seedOrder('c1', d.date, b.sym) ? -1 : 1)).slice(0, Math.min(d.K, d.all.length)));
const c2 = rowsOf((d) => [...d.weak].sort((a, b) => (seedOrder('c2', d.date, a.sym) < seedOrder('c2', d.date, b.sym) ? -1 : 1)).slice(0, d.K));
const c3 = byDay.flatMap((d) => d.signals.slice(0, d.K).map((f) => ({ date: d.date, val: f.nextDay - 0.001 })));

function summarize(rows) {
  const days = S.byDate(rows.map((r) => ({ date: r.date, val: r.val })));
  const vals = days.map((d) => d.val);
  const gross = S.mean(rows.map((r) => r.gross ?? NaN));
  return { trades: rows.length, dates: days.length, meanNet: S.mean(rows.map((r) => r.val)), meanNetByDate: S.mean(vals), p: S.blockP(vals, P.id + ':H2'), hit: rows.filter((r) => r.val > 0).length / rows.length, byYear: S.byYear(days), grossMean: gross, breakevenRoundTripCost: gross, maxDrawdownCum: (() => { let a = 0, pk = 0, m = 0; for (const v of vals) { a += v; pk = Math.max(pk, a); m = Math.min(m, a - pk); } return m; })(), concentrationTop5pctDays: S.concentration(days) };
}
function diffP(a, b) { // date-matched difference of per-date means
  const ma = new Map(S.byDate(a.map((r) => ({ date: r.date, val: r.val }))).map((d) => [d.date, d.val]));
  const mb = new Map(S.byDate(b.map((r) => ({ date: r.date, val: r.val }))).map((d) => [d.date, d.val]));
  const diffs = [...ma.keys()].filter((k) => mb.has(k)).sort().map((k) => ma.get(k) - mb.get(k));
  return { dates: diffs.length, meanDiff: S.mean(diffs), p: S.blockP(diffs, P.id + ':H2diff') };
}

const out = { period: DEV, censored: censoredCount, daysWithSignal: byDay.filter((d) => d.signals.length).length, days: byDay.length };
out.headline = summarize(head);
out.allSignals = summarize(allSignals);
out.control1Random = summarize(c1);
out.control2WeakRange = summarize(c2);
out.control3NextDayIntraday = { ...summarize(c3) };
out.excessOverC1 = diffP(head, c1);
out.excessOverC2 = diffP(head, c2);
const big = head.filter((r) => r.gapAbs > 0.10);
out.reportedSeparately = { tradesWithGapOver10pct: big.length, sumNetShare: head.reduce((s, r) => s + r.val, 0) !== 0 ? big.reduce((s, r) => s + r.val, 0) / head.reduce((s, r) => s + r.val, 0) : null, meanNetWithoutThem: S.mean(head.filter((r) => r.gapAbs <= 0.10).map((r) => r.val)) };
out.sensitivity = { halfCost: S.mean(head.map((r) => r.gross - ROUND / 2)), doubleCost: S.mean(head.map((r) => r.gross - ROUND * 2)) };
out.yearsPositive = out.headline.byYear.filter((y) => y.mean > 0).length;
out.p = out.headline.p;
fs.writeFileSync(path.join(__dirname, 'results-h2.json'), JSON.stringify(out, null, 2));
const f = (x) => S.pct(x, 3);
console.log(`H2: days ${out.days} (with signal ${out.daysWithSignal}); headline top-K trades ${out.headline.trades} on ${out.headline.dates} dates: gross ${f(out.headline.grossMean)} net ${f(out.headline.meanNet)} p ${out.headline.p.toFixed(4)} hit ${(out.headline.hit * 100).toFixed(1)}%`);
console.log(`   all signals: trades ${out.allSignals.trades} net ${f(out.allSignals.meanNet)}; C1 random net ${f(out.control1Random.meanNet)}; C2 weak-range net ${f(out.control2WeakRange.meanNet)}; C3 next-day intraday ${f(out.control3NextDayIntraday.meanNet)}`);
console.log(`   excess over C1 ${f(out.excessOverC1.meanDiff)} (p ${out.excessOverC1.p.toFixed(3)}), over C2 ${f(out.excessOverC2.meanDiff)} (p ${out.excessOverC2.p.toFixed(3)}); years ${out.headline.byYear.map((y) => `${y.year}:${f(y.mean)}`).join(' ')}`);

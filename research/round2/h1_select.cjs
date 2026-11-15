// H1 selection (no returns used): per development day, the top K(t) stocks by relative opening volume and K(t) seeded random control stocks.
// Writes data/h1_selection.json = { date: { top: [sym...], control: [sym...] } } for the 1-minute download.
const crypto = require('node:crypto');
const { fs, path } = require('./lib.cjs');
const { load5, V, D } = require('./load5.cjs');
const { dayData, sessions } = load5();
const elig = JSON.parse(fs.readFileSync(path.join(D, 'elig_S.json')));
const counts = JSON.parse(fs.readFileSync(path.join(D, 'eligibility_counts.json')));
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const DEV = P.common.periods.stocks.development;

function selectDay(i) { // i = index into sessions
  const date = sessions[i];
  const today = dayData.get(date);
  const eligible = [];
  for (const [sym, a] of today) {
    const e = elig[sym]?.[date];
    if (!e || !e[0]) continue;
    if (!(V(a, 0) > 0)) continue;
    eligible.push(sym);
  }
  const ranked = [];
  for (const sym of eligible) {
    let sum = 0, ok = i >= 14;
    for (let k = 1; k <= 14 && ok; k++) { const b = dayData.get(sessions[i - k])?.get(sym); const v = b ? V(b, 0) : NaN; if (!(v > 0)) ok = false; else sum += v; }
    if (!ok) continue;
    const rv = V(today.get(sym), 0) / (sum / 14);
    if (rv >= 1) ranked.push({ sym, rv });
  }
  ranked.sort((a, b) => b.rv - a.rv);
  const nS = eligible.length, nM = counts[date]?.h1 || 0;
  const K = Math.max(1, Math.round(20 * nS / Math.max(1, nM)));
  const control = eligible.map((s) => ({ s, h: crypto.createHash('sha256').update(`round2-1-h1-control|${date}|${s}`).digest('hex') })).sort((a, b) => a.h.localeCompare(b.h)).slice(0, K).map((x) => x.s);
  return { K, nS, nM, top: ranked.slice(0, K).map((r) => r.sym), rv: Object.fromEntries(ranked.slice(0, K).map((r) => [r.sym, r.rv])), eligibleRv: ranked.length, control };
}

if (require.main === module) {
  const out = {};
  for (let i = 0; i < sessions.length; i++) {
    const date = sessions[i];
    if (date < DEV[0] || date > DEV[1]) continue;
    out[date] = selectDay(i);
  }
  fs.writeFileSync(path.join(D, 'h1_selection.json'), JSON.stringify(out));
  const days = Object.values(out);
  console.log(`days ${days.length}; mean K ${(days.reduce((s, d) => s + d.K, 0) / days.length).toFixed(1)}; mean eligible in S ${(days.reduce((s, d) => s + d.nS, 0) / days.length).toFixed(0)}; mean market eligible ${(days.reduce((s, d) => s + d.nM, 0) / days.length).toFixed(0)}; mean with RV>=1 ${(days.reduce((s, d) => s + d.eligibleRv, 0) / days.length).toFixed(0)}`);
}
module.exports = { selectDay, dayData, sessions, elig, counts, P, DEV };

// eod-1 analysis. Follows protocol.json exactly. The validation period is only evaluated if the development gate passes.
// Verifies that protocol.json still matches the frozen hash before computing anything.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const protocolFile = path.join(__dirname, 'protocol.json');
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
const actual = crypto.createHash('sha256').update(fs.readFileSync(protocolFile)).digest('hex');
if (actual !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(fs.readFileSync(protocolFile));
const COST = P.cost.roundTripPct / 100;

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function ny(ms) {
  const o = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hhmm: `${o.hour === '24' ? '00' : o.hour}:${o.minute}` };
}

// ---- load + build one row per usable session ----
const dir = path.join(__dirname, 'data', 'spy5m');
const byDay = new Map();
for (const f of fs.readdirSync(dir).sort()) {
  for (const b of JSON.parse(fs.readFileSync(path.join(dir, f)))) {
    const { date, hhmm } = ny(Date.parse(b.t));
    (byDay.get(date) || byDay.set(date, new Map()).get(date)).set(hhmm, b);
  }
}
const dates = [...byDay.keys()].sort();
const excluded = { missingBars: 0, staleOrNoPrev: 0 };
const rows = [];
let prev = null; // { date, close }
for (const date of dates) {
  const d = byDay.get(date);
  const need = ['09:55', '15:30', '15:35', '15:55'];
  const last = d.get('15:55');
  if (!need.every((k) => d.has(k))) { excluded.missingBars += 1; if (last) prev = { date, close: Number(last.c) }; continue; }
  const gapDays = prev ? (Date.parse(date) - Date.parse(prev.date)) / 86400000 : Infinity;
  if (!prev || gapDays > 4) { excluded.staleOrNoPrev += 1; prev = { date, close: Number(last.c) }; continue; }
  rows.push({
    date, year: date.slice(0, 4),
    rFirst: Number(d.get('09:55').c) / prev.close - 1,
    rLast: Number(last.c) / Number(d.get('15:30').o) - 1,
    rLastLate: Number(last.c) / Number(d.get('15:35').o) - 1,
  });
  prev = { date, close: Number(last.c) };
}

const inRange = (r, [a, b]) => r.date >= a && r.date <= b;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const excessOf = (rs, cost = COST) => mean(rs.filter((r) => r.rFirst > 0).map((r) => r.rLast)) - cost - mean(rs.map((r) => r.rLast));
const netOf = (rs, key = 'rLast', cost = COST) => mean(rs.filter((r) => r.rFirst > 0).map((r) => r[key])) - cost;

function rng(seedText) { // mulberry32 seeded from the protocol id: reproducible
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 7);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function blockBootstrapLower(rs, block = 20, n = 2000) {
  const rand = rng(P.id), N = rs.length, stats = [];
  for (let i = 0; i < n; i++) {
    const sample = [];
    while (sample.length < N) { const s = Math.floor(rand() * N); for (let k = 0; k < block && sample.length < N; k++) sample.push(rs[(s + k) % N]); }
    stats.push(excessOf(sample));
  }
  stats.sort((a, b) => a - b);
  return stats[Math.floor(0.05 * n)];
}
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(4) + '%' : 'n/a');

const dev = rows.filter((r) => inRange(r, P.periods.development));
const sig = dev.filter((r) => r.rFirst > 0);
const years = [...new Set(dev.map((r) => r.year))];
const perYear = years.map((y) => ({ year: y, days: dev.filter((r) => r.year === y).length, excess: excessOf(dev.filter((r) => r.year === y)) }));
const result = {
  protocolSha256: actual,
  data: { sessionsUsed: rows.length, excluded },
  development: {
    days: dev.length, signalDays: sig.length,
    netMeanSignal: netOf(dev), allDaysMean: mean(dev.map((r) => r.rLast)), excess: excessOf(dev),
    bootstrapLower95: blockBootstrapLower(dev),
    perYear, yearsPositive: perYear.filter((y) => y.excess > 0).length,
  },
};
const g = result.development;
g.gate = {
  netMeanPositive: g.netMeanSignal > 0, lowerBoundPositive: g.bootstrapLower95 > 0,
  yearsOk: g.yearsPositive >= 3, enoughSignalDays: g.signalDays >= 350,
};
g.pass = Object.values(g.gate).every(Boolean);
// descriptive only (no tests, no decisions)
const sorted = [...dev].sort((a, b) => Math.abs(a.rFirst) - Math.abs(b.rFirst));
const third = Math.floor(sorted.length / 3);
result.descriptive = {
  mirrorMeanRLastWhenRFirstNonPositive: mean(dev.filter((r) => r.rFirst <= 0).map((r) => r.rLast)),
  excessAtCost005: excessOf(dev, 0.0005),
  terciles: [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)].map((t) => ({ meanAbsRFirst: mean(t.map((r) => Math.abs(r.rFirst))), meanRLastSignalOnly: mean(t.filter((r) => r.rFirst > 0).map((r) => r.rLast)) })),
};

if (g.pass) {
  const val = rows.filter((r) => inRange(r, P.periods.validation));
  const v = { days: val.length, signalDays: val.filter((r) => r.rFirst > 0).length, netMeanSignal: netOf(val), excess: excessOf(val), lateEntryNetMean: netOf(val, 'rLastLate') };
  v.pass = v.excess > 0 && v.netMeanSignal > 0 && v.lateEntryNetMean > 0;
  result.validation = v;
} else {
  result.validation = 'NOT opened: development gate failed (protocol.json gates.validation)';
}

fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 2));
console.log(`sessions used ${rows.length} (excluded: ${JSON.stringify(excluded)})`);
console.log(`DEV  days ${g.days}, signal days ${g.signalDays}`);
console.log(`     net mean on signal days ${pct(g.netMeanSignal)}; all-days mean ${pct(g.allDaysMean)}; excess ${pct(g.excess)}; bootstrap 95% lower ${pct(g.bootstrapLower95)}`);
console.log('     by year: ' + perYear.map((y) => `${y.year}: ${pct(y.excess)} (${y.days}d)`).join('  '));
console.log(`     gate ${JSON.stringify(g.gate)} => ${g.pass ? 'PASS' : 'FAIL'}`);
console.log('VALIDATION: ' + (typeof result.validation === 'string' ? result.validation : JSON.stringify(result.validation)));

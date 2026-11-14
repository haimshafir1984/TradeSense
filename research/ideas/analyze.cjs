// ideas-2 analysis (HA, HB, HD, HE, HF; HC is computed by hc.cjs). Follows protocol.json exactly and refuses to run if it differs from the frozen hash.
// Development is computed for everything; validation (2024) only for hypotheses that pass the development gate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const protocolFile = path.join(__dirname, 'protocol.json');
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json')));
const frozen = (reg.amended?.at(-1) || reg.files['protocol.json']).sha256;
const actual = crypto.createHash('sha256').update(fs.readFileSync(protocolFile)).digest('hex');
if (actual !== frozen) { console.error('protocol.json differs from the frozen hash. Refusing to run.'); process.exit(1); }
const P = JSON.parse(fs.readFileSync(protocolFile));
const D = path.join(__dirname, 'data');
const U = JSON.parse(fs.readFileSync(path.join(D, 'universe.json'))).symbols;
const pairs = JSON.parse(fs.readFileSync(path.join(D, 'pairs.json'))).pairs;
const bases = new Set(pairs.map((p) => p.base));
const dailyHE = JSON.parse(fs.readFileSync(path.join(D, 'daily_he.json')));

// ---------------- data ----------------
const raw = new Map(); // symbol -> Map date -> {o,h,l,c: Float64Array(78), real: Uint8Array(78)}
for (const g of ['U', 'HF', 'HE']) {
  const dir = path.join(D, 'm5', g);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f)));
    for (const [sym, rows] of Object.entries(obj)) {
      const days = raw.get(sym) || raw.set(sym, new Map()).get(sym);
      for (const [date, i, o, h, l, c] of rows) {
        let d = days.get(date);
        if (!d) { d = { o: new Float64Array(78).fill(NaN), h: new Float64Array(78).fill(NaN), l: new Float64Array(78).fill(NaN), c: new Float64Array(78).fill(NaN), real: new Uint8Array(78) }; days.set(date, d); }
        d.o[i] = o; d.h[i] = h; d.l[i] = l; d.c[i] = c; d.real[i] = 1;
      }
    }
  }
}
// forward-fill inside the session (amendment 1); a stock-day needs >= 25 real candles
const stock = new Map();
for (const [sym, days] of raw) {
  const out = new Map();
  for (const [date, d] of days) {
    let n = 0; for (let i = 0; i < 78; i++) n += d.real[i];
    if (n < 25) continue;
    let last = NaN;
    const x = { o: new Float64Array(78), h: new Float64Array(78), l: new Float64Array(78), c: new Float64Array(78), real: d.real };
    for (let i = 0; i < 78; i++) {
      if (d.real[i]) { x.o[i] = d.o[i]; x.h[i] = d.h[i]; x.l[i] = d.l[i]; x.c[i] = d.c[i]; last = d.c[i]; }
      else { x.o[i] = x.h[i] = x.l[i] = x.c[i] = last; }
    }
    out.set(date, x);
  }
  stock.set(sym, out);
}
const spy = stock.get('SPY');
const sessions = [...spy.keys()].sort();
const sessIdx = new Map(sessions.map((d, i) => [d, i]));
console.log(`symbols ${stock.size}, SPY sessions ${sessions.length}`);

// ---------------- helpers ----------------
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const std = (xs) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const inRange = (date, [a, b]) => date >= a && date <= b;
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(3) + '%' : 'n/a');

function rng(seedText) {
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 7);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function byDate(events) { // events: {date, val}
  const m = new Map();
  for (const e of events) (m.get(e.date) || m.set(e.date, []).get(e.date)).push(e.val);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, vals]) => ({ date, val: mean(vals), n: vals.length }));
}
function bootstrapP(dayMeans, block = 20, n = 2000) {
  const N = dayMeans.length;
  if (N < 5) return 1;
  const rand = rng(P.id);
  let le = 0;
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    while (cnt < N) { const s = Math.floor(rand() * N); for (let b = 0; b < block && cnt < N; b++, cnt++) sum += dayMeans[(s + b) % N].val; }
    if (sum / N <= 0) le += 1; // protocol: share of resamples whose statistic is <= 0
  }
  return Math.max(le / n, 1 / n);
}
function summarize(events, minEvents, minDates) {
  const days = byDate(events);
  const stat = mean(days.map((d) => d.val));
  const years = {};
  for (const d of days) (years[d.date.slice(0, 4)] ||= []).push(d.val);
  const yearRows = Object.entries(years).map(([y, v]) => ({ year: y, dates: v.length, mean: mean(v) }));
  const judged = yearRows.filter((y) => y.dates >= 8);
  return {
    events: events.length, eventDates: days.length, meanNetExcess: stat, meanEventLevel: mean(events.map((e) => e.val)),
    p: bootstrapP(days), years: yearRows, negativeYears: judged.filter((y) => y.mean <= 0).length,
    enough: events.length >= minEvents && days.length >= minDates,
  };
}

// beta / sd for stock s on date d from the previous 10 sessions
const statCache = new Map();
function stats(sym, date) {
  const key = `${sym}|${date}`;
  if (statCache.has(key)) return statCache.get(key);
  const days = stock.get(sym);
  const i = sessIdx.get(date);
  let res = null;
  if (i >= 10) {
    const prev = sessions.slice(i - 10, i).filter((x) => days.has(x));
    if (prev.length >= 8) {
      let sxy = 0, sxx = 0, sx = 0, sy = 0, n = 0;
      for (const pd of prev) {
        const a = days.get(pd), b = spy.get(pd);
        for (let k = 1; k < 78; k++) {
          if (!(a.real[k] && a.real[k - 1])) continue;
          const rs = Math.log(a.c[k] / a.c[k - 1]), rm = Math.log(b.c[k] / b.c[k - 1]);
          if (!Number.isFinite(rs) || !Number.isFinite(rm)) continue;
          sxy += rs * rm; sxx += rm * rm; sx += rm; sy += rs; n += 1;
        }
      }
      if (n >= 200) {
        const cov = sxy / n - (sx / n) * (sy / n), vr = sxx / n - (sx / n) ** 2;
        const beta = Math.min(3, Math.max(0.3, vr > 0 ? cov / vr : 1));
        const resid = [], r6 = [];
        for (const pd of prev) {
          const a = days.get(pd), b = spy.get(pd);
          for (let t = 12; t <= 72; t += 12) {
            const rs = a.c[t] / a.c[t - 12] - 1, rm = b.c[t] / b.c[t - 12] - 1;
            if (Number.isFinite(rs) && Number.isFinite(rm)) resid.push(rs - beta * rm);
          }
          for (let t = 6; t <= 72; t += 6) { const r = a.c[t] / a.c[t - 6] - 1; if (Number.isFinite(r)) r6.push(r); }
        }
        if (resid.length >= 40) res = { beta, sd: std(resid), sd30: std(r6) };
      }
    }
  }
  statCache.set(key, res);
  return res;
}

const ret = (x, y) => y / x - 1;
function window12(sym, date, t) { // r, z, beta for the 12-candle window ending at t
  const d = stock.get(sym)?.get(date), s = spy.get(date), st = stats(sym, date);
  if (!d || !st || !(st.sd > 0)) return null;
  const r = d.c[t] / d.c[t - 12] - 1, rm = s.c[t] / s.c[t - 12] - 1;
  if (!Number.isFinite(r) || !Number.isFinite(rm)) return null;
  return { r, z: (r - st.beta * rm) / st.sd, beta: st.beta };
}
function fwd(sym, date, entryIdx, exitIdx) {
  const d = stock.get(sym)?.get(date);
  if (!d) return NaN;
  const v = d.c[exitIdx] / d.o[entryIdx] - 1;
  return Number.isFinite(v) ? v : NaN;
}

// ---------------- hypotheses ----------------
function runHA_HB(kind, period) {
  const H = P.hypotheses[kind], cost = H.costRoundTripPct / 100;
  const events = []; let censored = 0;
  for (const date of sessions) {
    if (!inRange(date, period)) continue;
    const s = spy.get(date);
    const done = new Set();
    for (let t = 12; t <= 60; t++) {
      const rm = s.c[t] / s.c[t - 12] - 1;
      if (kind === 'HA') {
        if (!(rm <= -0.005)) continue;
        let argmin = t - 11, lo = Infinity;
        for (let k = t - 11; k <= t; k++) if (s.l[k] < lo) { lo = s.l[k]; argmin = k; }
        if (argmin > t - 3) continue;
      }
      const pool = [];
      for (const sym of U) {
        const days = stock.get(sym); if (!days?.has(date)) continue;
        const w = window12(sym, date, t); if (!w) continue;
        if (kind === 'HB') { const d = days.get(date), prevDate = sessions[sessIdx.get(date) - 1]; const pc = days.get(prevDate)?.c[77]; if (Number.isFinite(pc) && Math.abs(d.o[0] / pc - 1) >= 0.04) continue; }
        pool.push({ sym, ...w });
      }
      for (const e of pool) {
        if (done.has(e.sym)) continue;
        let hit = false;
        if (kind === 'HA') hit = e.r >= 0 && e.z >= 1.0;
        else {
          if (!(e.z <= -2.0 && e.r <= -0.005)) continue;
          const d = stock.get(e.sym).get(date);
          let argmin = t - 11, lo = Infinity;
          for (let k = t - 11; k <= t; k++) if (d.l[k] < lo) { lo = d.l[k]; argmin = k; }
          hit = argmin <= t - 3;
        }
        if (!hit) continue;
        done.add(e.sym);
        const f = fwd(e.sym, date, t + 2, t + 13);
        const ctl = pool.filter((c) => c.sym !== e.sym && Math.abs(c.beta - e.beta) <= 0.3 && Math.abs(c.z) <= 1 && (kind === 'HA' ? c.r < 0 : true)).map((c) => fwd(c.sym, date, t + 2, t + 13)).filter(Number.isFinite);
        if (!Number.isFinite(f) || ctl.length < 3) { censored += 1; continue; }
        events.push({ date, val: f - cost - mean(ctl), sym: e.sym, t });
      }
    }
  }
  return { events, censored };
}

function runHD(period) {
  const cost = P.hypotheses.HD.costRoundTripPct / 100;
  const events = []; let nDecisions = 0;
  for (const date of sessions) {
    if (!inRange(date, period)) continue;
    for (const sym of U) {
      const d = stock.get(sym)?.get(date), st = stats(sym, date);
      if (!d || !st || !(st.sd30 > 0)) continue;
      const c5 = d.c[5]; if (!Number.isFinite(c5)) continue;
      nDecisions += 1;
      const limit = c5 * (1 - 1.5 * st.sd30);
      if (!(limit > 0)) continue;
      let fill = -1;
      for (let i = 6; i <= 11; i++) if (d.real[i] && d.l[i] < limit * (1 - 0.0005)) { fill = i; break; }
      if (fill < 0) continue;
      const exit = Math.min(fill + 12, 77);
      const v = d.c[exit] / limit - 1;
      if (Number.isFinite(v)) events.push({ date, val: v - cost, sym });
    }
  }
  return { events, censored: 0, nDecisions };
}

function adv20(daily, date) {
  const rows = (daily || []).filter((r) => r[0] < date).slice(-20);
  return rows.length >= 10 ? mean(rows.map((r) => r[1] * r[2])) : NaN;
}
let heCutoff = null;
function runHE(period, setCutoff) {
  const H = P.hypotheses.HE, cost = H.costRoundTripPct / 100;
  const etfsOf = new Map();
  for (const p of pairs) (etfsOf.get(p.base) || etfsOf.set(p.base, []).get(p.base)).push(p.etf);
  const cand = []; let censored = 0;
  for (const date of sessions) {
    if (!inRange(date, period)) continue;
    const prevDate = sessions[sessIdx.get(date) - 1];
    const pool = [];
    for (const sym of [...stock.keys()]) {
      const d = stock.get(sym).get(date), pd = stock.get(sym).get(prevDate);
      if (!d || !pd) continue;
      const pc = pd.c[77]; if (!Number.isFinite(pc)) continue;
      const r = d.c[65] / pc - 1;
      if (!(r >= 0.03)) continue;
      pool.push({ sym, d });
    }
    const treatedPool = pool.filter((p) => bases.has(p.sym)), controls = pool.filter((p) => !bases.has(p.sym) && U.includes(p.sym));
    for (const e of treatedPool) {
      const base = adv20(dailyHE[e.sym], date);
      const etfAdv = (etfsOf.get(e.sym) || []).map((x) => adv20(dailyHE[x], date)).filter(Number.isFinite);
      if (!(base > 0) || !etfAdv.length) { censored += 1; continue; }
      const f = e.d.c[77] / e.d.o[66] - 1;
      const ctl = controls.map((c) => c.d.c[77] / c.d.o[66] - 1).filter(Number.isFinite);
      if (!Number.isFinite(f) || ctl.length < 2) { censored += 1; continue; }
      cand.push({ date, rho: etfAdv.reduce((s, x) => s + x, 0) / base, val: f - cost - mean(ctl), sym: e.sym });
    }
  }
  if (setCutoff) { const rhos = cand.map((c) => c.rho).sort((a, b) => a - b); heCutoff = rhos[Math.floor(rhos.length * 2 / 3)]; }
  const events = cand.filter((c) => c.rho >= heCutoff);
  return { events, censored, candidates: cand.length, cutoff: heCutoff };
}

function runHF(period) {
  const H = P.hypotheses.HF, cost = H.costRoundTripPct / 100;
  const events = []; let censored = 0;
  for (const date of sessions) {
    if (!inRange(date, period)) continue;
    const s = spy.get(date);
    for (const [group, [leader, followers]] of Object.entries(H.groups)) {
      const L = stock.get(leader)?.get(date); if (!L) continue;
      const done = new Set();
      for (let t = 6; t <= 64; t++) {
        const rm = s.c[t] / s.c[t - 6] - 1;
        const rl = L.c[t] / L.c[t - 6] - 1;
        if (!(rl - rm >= 0.02)) continue;
        for (const f of followers) {
          if (done.has(f)) continue;
          const F = stock.get(f)?.get(date); if (!F) continue;
          const rf = F.c[t] / F.c[t - 6] - 1;
          if (!(rf - rm <= 0.005)) continue;
          done.add(f);
          const fw = F.c[t + 8] / F.o[t + 2] - 1;
          const ctl = U.map((sym) => fwdU(sym, date, t + 2, t + 8)).filter(Number.isFinite);
          if (!Number.isFinite(fw) || ctl.length < 5) { censored += 1; continue; }
          events.push({ date, val: fw - cost - mean(ctl), sym: f, group });
        }
      }
    }
  }
  return { events, censored };
}
function fwdU(sym, date, a, b) { const d = stock.get(sym)?.get(date); if (!d) return NaN; const v = d.c[b] / d.o[a] - 1; return Number.isFinite(v) ? v : NaN; }

// ---------------- run ----------------
const results = { protocolSha256: actual, development: {}, validation: {} };
const specs = {
  HA: (period) => runHA_HB('HA', period),
  HB: (period) => runHA_HB('HB', period),
  HD: (period) => runHD(period),
  HE: (period, first) => runHE(period, first),
  HF: (period) => runHF(period),
};
const devPeriod = (h) => (h === 'HE' ? P.hypotheses.HE.period.development : P.common.periods.development);
const valPeriod = (h) => (h === 'HE' ? P.hypotheses.HE.period.validation : P.common.periods.validation);
for (const h of Object.keys(specs)) {
  const t0 = Date.now();
  const run = specs[h](devPeriod(h), true);
  const H = P.hypotheses[h];
  const s = summarize(run.events, H.minEvents, H.minEventDates);
  results.development[h] = { ...s, censored: run.censored, extra: { candidates: run.candidates, cutoff: run.cutoff, decisions: run.nDecisions } };
  console.log(`${h} dev: events ${s.events} on ${s.eventDates} dates (censored ${run.censored}); mean net excess ${pct(s.meanNetExcess)} (event-level ${pct(s.meanEventLevel)}); p ${s.p.toFixed(4)}; years ${s.years.map((y) => `${y.year}:${pct(y.mean)}/${y.dates}d`).join(' ')}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
}
// HC p-value, if computed
let hcP = 1;
const hcFile = path.join(__dirname, 'results-hc.json');
if (fs.existsSync(hcFile)) { const hc = JSON.parse(fs.readFileSync(hcFile)); results.development.HC = hc.development; hcP = hc.development.p; }
const names = ['HA', 'HB', 'HD', 'HE', 'HF', 'HC'];
const ps = names.map((n) => ({ n, p: n === 'HC' ? hcP : results.development[n].p })).sort((a, b) => a.p - b.p);
let running = 0;
ps.forEach((x, i) => { running = Math.max(running, Math.min(1, x.p * (names.length - i))); results.development[x.n] = { ...(results.development[x.n] || {}), holmP: running }; });
for (const n of names) {
  const r = results.development[n];
  if (!r || n === 'HC' && !fs.existsSync(hcFile)) { console.log(`${n}: pending (news test not run yet)`); continue; }
  if (n === 'HC') { r.pass = r.diffOk && r.enough && r.holmP < 0.05; } else r.pass = r.enough && r.meanNetExcess > 0 && r.holmP < 0.05 && r.negativeYears <= 1;
  console.log(`${n}: gate ${r.pass ? 'PASS' : 'FAIL'} (enough ${r.enough}, mean>0 ${r.meanNetExcess > 0}, Holm p ${r.holmP?.toFixed(4)}, negative years ${r.negativeYears})`);
  if (r.pass && n !== 'HC') {
    const run = specs[n](valPeriod(n), false);
    const v = summarize(run.events, 30, 1);
    results.validation[n] = { events: v.events, mean: v.meanNetExcess, pass: v.events >= 30 && v.meanNetExcess > 0 };
    console.log(`   validation: ${JSON.stringify(results.validation[n])}`);
  }
}
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));

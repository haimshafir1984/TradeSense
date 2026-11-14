// ideas-2: builds universe U (as of the last trading day of 2020) and the leveraged-ETF -> base pairs (HE). Uses NO forward returns.
const fs = require('node:fs');
const path = require('node:path');
const V6 = path.resolve(__dirname, '../v6/data');
const out = path.join(__dirname, 'data');
fs.mkdirSync(out, { recursive: true });

const files = fs.readdirSync(path.join(V6, 'bars'));
const rows = [];
for (const f of files) {
  const bars = JSON.parse(fs.readFileSync(path.join(V6, 'bars', f))).filter((b) => b.t.slice(0, 10) <= '2020-12-31');
  if (bars.length < 25) continue;
  const w = bars.slice(-20);
  const adv = w.reduce((s, b) => s + b.c * b.v, 0) / 20;
  const range = w.reduce((s, b) => s + (b.h - b.l) / b.c, 0) / 20;
  rows.push({ symbol: f.replace('.json', ''), close: bars.at(-1).c, adv, range, last: bars.at(-1).t.slice(0, 10) });
}
const eligible = rows.filter((r) => r.last >= '2020-12-20' && r.close >= 5 && r.adv >= 3e6 && r.adv <= 150e6).sort((a, b) => b.range - a.range);
const U = eligible.slice(0, 100).map((r) => r.symbol);
fs.writeFileSync(path.join(out, 'universe.json'), JSON.stringify({ asOf: '2020-12-31', candidates: rows.length, eligible: eligible.length, symbols: U }, null, 2));
console.log(`candidates ${rows.length}, eligible ${eligible.length}, U ${U.length}`);

// ETF pairs
const assets = JSON.parse(fs.readFileSync(path.join(V6, 'assets.json')));
const active = new Set(assets.map((a) => a.symbol));
const pairs = [];
let unparsed = 0;
for (const a of assets) {
  const name = a.name || '';
  if (!/\b[23]x\b/i.test(name) || !/\b(long|bull|short|bear)\b/i.test(name)) continue;
  const m = name.match(/\b(?:long|bull|short|bear)\b\s+(.*)$/i);
  const tokens = (m?.[1] || '').split(/\s+/).map((t) => t.replace(/[^A-Za-z]/g, ''));
  const base = tokens.find((t) => /^[A-Z]{1,5}$/.test(t) && active.has(t) && t !== 'ETF' && t !== 'ETN');
  if (!base) { unparsed += 1; continue; }
  pairs.push({ etf: a.symbol, base, name });
}
fs.writeFileSync(path.join(out, 'pairs.json'), JSON.stringify({ unparsed, pairs }, null, 2));
console.log(`ETF pairs ${pairs.length} (unparsed ${unparsed}); distinct bases ${new Set(pairs.map((p) => p.base)).size}`);
console.log(pairs.slice(0, 8).map((p) => `${p.etf}->${p.base}`).join(' '));

// Step 4: Benzinga headlines (Alpaca news API) published between the previous session's close (16:00 New York) and 09:30 of each
// development day, for the sample stocks that are H2-eligible that day. One file per day with the raw headlines (classification happens in the analysis).
const { get, fs, path, nyToIso, acquireDownloadLock } = require('./lib.cjs');
const D = path.join(__dirname, 'data');
(async () => {
  await acquireDownloadLock();
  const elig = JSON.parse(fs.readFileSync(path.join(D, 'elig_S.json')));
  const files = fs.readdirSync(path.join(D, 'm5')).map((f) => f.slice(0, 10)).sort().filter((d) => d >= '2021-01-01');
  const all = fs.readdirSync(path.join(D, 'm5')).map((f) => f.slice(0, 10)).sort();
  fs.mkdirSync(path.join(D, 'news'), { recursive: true });
  let done = 0;
  for (const date of files) {
    const file = path.join(D, 'news', `${date}.json`);
    if (fs.existsSync(file)) { done += 1; continue; }
    const prev = all[all.indexOf(date) - 1];
    const syms = Object.keys(elig).filter((s) => elig[s][date]?.[1] || elig[s][prev]?.[1]);
    const list = new Set(syms);
    const out = [];
    for (let i = 0; i < syms.length; i += 150) {
      let token = null;
      do {
        const p = new URLSearchParams({ symbols: syms.slice(i, i + 150).join(','), start: nyToIso(prev, '16:00'), end: nyToIso(date, '09:30'), limit: '50', sort: 'asc' });
        if (token) p.set('page_token', token);
        const j = await get('https://data.alpaca.markets/v1beta1/news?' + p);
        for (const n of j.news || []) out.push({ t: n.created_at, h: n.headline, s: (n.symbols || []).filter((x) => list.has(x)), n: (n.symbols || []).length });
        token = j.next_page_token || null;
      } while (token);
    }
    fs.writeFileSync(file, JSON.stringify(out));
    done += 1;
    if (done % 25 === 0) console.log(`news day ${done}/${files.length} ${date}: ${out.length} articles`);
  }
  console.log('step4 done');
})().catch((e) => { console.error('step4 failed:', e.message); process.exit(1); });

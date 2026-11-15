// Holm correction over the six primary hypotheses on development p-values, and the development pass flags. Run after all development analyses.
const { fs, path } = require('./lib.cjs');
const rd = (f) => (fs.existsSync(path.join(__dirname, f)) ? JSON.parse(fs.readFileSync(path.join(__dirname, f))) : null);
const idx = rd('results-index.json'), h1 = rd('results-h1.json'), h2 = rd('results-h2.json'), ev = rd('results-events.json');
const items = {
  H1: { p: h1?.p ?? 1, have: !!h1 }, H2: { p: h2?.p ?? 1, have: !!h2 },
  H3: { p: idx?.H3?.SPY?.longOnlyOurCost?.p ?? 1, have: !!idx }, C2: { p: idx?.C2?.SPY?.difference?.p ?? 1, have: !!idx },
  H5: { p: ev?.H5?.p ?? 1, have: !!ev }, H6: { p: ev?.H6?.p ?? 1, have: !!ev },
};
const order = Object.entries(items).sort((a, b) => a[1].p - b[1].p);
let run = 0; order.forEach(([k, v], i) => { run = Math.max(run, Math.min(1, v.p * (order.length - i))); items[k].holm = run; });
const pass = {};
const s3 = idx?.H3?.SPY;
pass.H1 = !!h1 && !!h1.reproduction?.pass && h1.topLong?.primary?.meanNetRByDate > 0 && items.H1.holm < 0.05 && h1.excessOverControl > 0 && h1.yearsPositive >= 2;
pass.H2 = !!h2 && h2.headline.meanNet > 0 && items.H2.holm < 0.05 && h2.excessOverC1.meanDiff > 0 && h2.excessOverC2.meanDiff > 0 && h2.yearsPositive >= 2;
pass.H3 = !!s3 && s3.longOnlyOurCost.meanDaily > 0 && items.H3.holm < 0.05 && s3.longOnlyOurCost.sharpe > s3.controlBuyHoldOpenClose.sharpe && s3.longOnlyOurCost.sharpe > s3.controlBuyHold10to16.sharpe;
pass.C2 = !!idx && idx.C2.SPY.combined.meanDaily > 0 && items.C2.holm < 0.05;
pass.H5 = !!ev?.testable && !ev.H5.statistic.underpowered && ev.H5.statistic.combinedMinusVolumeOnly > 0 && items.H5.holm < 0.05 && ev.H5.groups.COMBINED.meanNetR > 0;
pass.H6 = !!ev?.testable && !ev.H6.statistic.underpowered && ev.H6.statistic.eventMinusControl > 0 && items.H6.holm < 0.05 && ev.H6.groups.event.meanNetR > 0;
const out = { holm: items, pass, missing: Object.entries(items).filter(([, v]) => !v.have).map(([k]) => k) };
fs.writeFileSync(path.join(__dirname, 'final_dev.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));

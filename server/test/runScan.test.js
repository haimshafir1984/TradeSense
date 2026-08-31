const test = require('node:test');
const assert = require('node:assert/strict');

function freshServices() {
  delete require.cache[require.resolve('../src/services/universeBuilderService')];
  delete require.cache[require.resolve('../src/providers/alpacaService')];
  delete require.cache[require.resolve('../src/pipeline/catalystService')];
  delete require.cache[require.resolve('../src/pipeline/regimeGate')];
  delete require.cache[require.resolve('../src/pipeline/runScan')];
  return {
    universeBuilderService: require('../src/services/universeBuilderService'),
    alpacaService: require('../src/providers/alpacaService'),
    catalystService: require('../src/pipeline/catalystService'),
    regimeGate: require('../src/pipeline/regimeGate'),
    runScan: require('../src/pipeline/runScan')
  };
}

function goodBars(count = 250) {
  const bars = [];
  let price = 50;
  for (let i = 0; i < count; i += 1) {
    price += 0.5 * (i % 2 === 0 ? 1 : -1) + 0.05;
    bars.push({ t: `2026-01-01T00:00:00Z`, o: price, h: price + 2, l: price - 2, c: price, v: 3000000 });
  }
  return bars;
}

const FAKE_REGIME = { state: 'neutral', spyAboveMa200: true, realizedVol20d: 0.01, blockedTiers: [] };

test('an empty/missing universe returns an explicit warning and empty shortlist instead of throwing', async () => {
  const { universeBuilderService, runScan } = freshServices();
  universeBuilderService.getUniverseWithLazyRefresh = async () => null;

  const result = await runScan.runScan({ exchange: 'NASDAQ' });

  assert.deepEqual(result.shortlist, []);
  assert.equal(result.diagnostics.stage, 'universe');
  assert.ok(result.warnings.length > 0);
});

test('a full run: liquid, catalyst-tagged, rvol-ranked shortlist with diagnostics counting every stage', async () => {
  const { universeBuilderService, alpacaService, catalystService, regimeGate, runScan } = freshServices();

  universeBuilderService.getUniverseWithLazyRefresh = async () => ({
    rows: [
      { symbol: 'GOOD', companyName: 'Good Inc', sector: 'Tech', marketCap: 5000000000 },
      { symbol: 'THIN', companyName: 'Thin Inc', sector: 'Tech', marketCap: 1000000000 }
    ]
  });

  alpacaService.getDailyBars = async () =>
    new Map([
      ['GOOD', goodBars(250)],
      ['THIN', goodBars(50)] // too little history - liquidity gate should reject it
    ]);

  catalystService.detectCatalysts = async (symbols) => new Map(symbols.map((symbol) => [symbol, { kind: null, confidence: 'low' }]));
  regimeGate.assessRegime = async () => FAKE_REGIME;

  const result = await runScan.runScan({ exchange: 'NASDAQ', topN: 10 });

  assert.equal(result.diagnostics.universeCount, 2);
  assert.equal(result.diagnostics.afterLiquidityGate, 1);
  assert.equal(result.diagnostics.liquidityRejectedSample[0].symbol, 'THIN');
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].symbol, 'GOOD');
  assert.ok(result.shortlist[0].catalyst);
  assert.deepEqual(result.regime, FAKE_REGIME);
});

test('when nothing survives the liquidity gate, diagnostics explain it without calling catalyst/regime', async () => {
  const { universeBuilderService, alpacaService, catalystService, regimeGate, runScan } = freshServices();

  universeBuilderService.getUniverseWithLazyRefresh = async () => ({
    rows: [{ symbol: 'THIN', companyName: 'Thin Inc', sector: 'Tech', marketCap: 1000000000 }]
  });
  alpacaService.getDailyBars = async () => new Map([['THIN', goodBars(20)]]);

  let catalystCalled = false;
  let regimeCalled = false;
  catalystService.detectCatalysts = async () => {
    catalystCalled = true;
    return new Map();
  };
  regimeGate.assessRegime = async () => {
    regimeCalled = true;
    return FAKE_REGIME;
  };

  const result = await runScan.runScan({ exchange: 'NASDAQ' });

  assert.equal(result.diagnostics.stage, 'liquidity');
  assert.equal(result.shortlist.length, 0);
  assert.equal(catalystCalled, false);
  assert.equal(regimeCalled, false);
});

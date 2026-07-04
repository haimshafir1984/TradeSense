const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshScanHistoryService(scratchPath) {
  process.env.SCAN_HISTORY_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/scanHistoryStore')];
  delete require.cache[require.resolve('../src/services/scanHistoryService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  return require('../src/services/scanHistoryService');
}

test('recordScan persists a scan and evaluateOutcomes computes hit/miss vs SPY after the horizon', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-test-${Date.now()}.json`);
  const { recordScan, evaluateOutcomes, buildHitRateReport } = freshScanHistoryService(scratchPath);

  await recordScan({
    exchange: 'NASDAQ',
    strategy: 'ross_cameron', // 5-day horizon, the shortest, easiest to simulate as "already elapsed"
    risk: 'medium',
    results: [
      { ticker: 'WINNER', price: 100, opportunityRank: 82 },
      { ticker: 'LOSER', price: 100, opportunityRank: 30 }
    ],
    spyPriceAtScan: 500
  });

  // Backdate the scan so it's past the ross_cameron 5-day horizon, and inject fake current
  // prices via a mocked getStockSnapshot instead of hitting a real provider.
  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  raw.scans[0].scannedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(scratchPath, JSON.stringify(raw, null, 2));

  const marketDataService = require('../src/services/marketDataService');
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { price: 510 }; // SPY +2%
    if (ticker === 'WINNER') return { price: 120 }; // stock +20%, beat SPY
    if (ticker === 'LOSER') return { price: 95 }; // stock -5%, lagged SPY
    return { price: 100 };
  };

  const { evaluatedCount } = await evaluateOutcomes({ now: new Date() });
  const report = await buildHitRateReport();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  fs.unlinkSync(scratchPath);
  delete process.env.SCAN_HISTORY_FILE_PATH;

  assert.equal(evaluatedCount, 2);
  assert.equal(report.byStrategy.ross_cameron.count, 2);
  assert.equal(report.byStrategy.ross_cameron.hits, 1);
  assert.equal(report.pendingCount, 0);
});

test('recordScan stores top-5 picks from other strategies and the league declares a leader once it has enough samples', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-league-test-${Date.now()}.json`);
  const { recordScan, evaluateOutcomes, buildHitRateReport } = freshScanHistoryService(scratchPath);

  // 12 scans so mark_minervini crosses the min-samples-to-lead threshold (10) while
  // micha_stocks stays under it and can never be declared the leader.
  for (let index = 0; index < 12; index += 1) {
    await recordScan({
      exchange: 'NASDAQ',
      strategy: 'ross_cameron',
      risk: 'medium',
      results: [{ ticker: `SEL${index}`, price: 100, opportunityRank: 50 }],
      spyPriceAtScan: 500,
      strategyTopPicks: {
        ross_cameron: [{ ticker: `SEL${index}`, price: 100, score: 0.5 }],
        mark_minervini: [{ ticker: `MM${index}`, price: 100, score: 0.6 }],
        micha_stocks: [{ ticker: `MC${index}`, price: 100, score: 0.4 }]
      }
    });
  }

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  for (const scan of raw.scans) {
    scan.scannedAt = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();
  }
  fs.writeFileSync(scratchPath, JSON.stringify(raw, null, 2));

  const marketDataService = require('../src/services/marketDataService');
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { price: 500 }; // SPY flat
    if (ticker.startsWith('MM')) return { price: 130 }; // mark_minervini picks: +30%, best performer
    if (ticker.startsWith('MC')) return { price: 105 }; // micha_stocks picks: +5%
    return { price: 100 }; // ross_cameron (selected) picks: flat
  };

  await evaluateOutcomes({ now: new Date() });
  const report = await buildHitRateReport();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  fs.unlinkSync(scratchPath);
  delete process.env.SCAN_HISTORY_FILE_PATH;

  assert.equal(report.byStrategy.mark_minervini.count, 12);
  assert.equal(report.byStrategy.micha_stocks.count, 12);
  assert.equal(report.byStrategy.ross_cameron.count, 12);
  assert.equal(report.league.leadingStrategy, 'mark_minervini');
  assert.equal(report.league.byStrategy.mark_minervini.count, 12);
  assert.equal(report.league.minSamplesToLead, 10);
});

test('league does not declare a leader when no strategy has reached the minimum sample size', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-league-nosample-${Date.now()}.json`);
  const { recordScan, evaluateOutcomes, buildHitRateReport } = freshScanHistoryService(scratchPath);

  await recordScan({
    exchange: 'NASDAQ',
    strategy: 'ross_cameron',
    risk: 'medium',
    results: [{ ticker: 'SEL', price: 100, opportunityRank: 50 }],
    spyPriceAtScan: 500,
    strategyTopPicks: {
      ross_cameron: [{ ticker: 'SEL', price: 100, score: 0.5 }],
      mark_minervini: [{ ticker: 'MM1', price: 100, score: 0.6 }]
    }
  });

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  raw.scans[0].scannedAt = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(scratchPath, JSON.stringify(raw, null, 2));

  const marketDataService = require('../src/services/marketDataService');
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { price: 500 };
    return { price: 150 };
  };

  await evaluateOutcomes({ now: new Date() });
  const report = await buildHitRateReport();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  fs.unlinkSync(scratchPath);
  delete process.env.SCAN_HISTORY_FILE_PATH;

  assert.equal(report.league.leadingStrategy, null);
});

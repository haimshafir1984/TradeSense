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

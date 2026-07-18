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

test('buildHitRateReport computes a measured risk profile (median/worst/pctBelowMinus10) per strategy+opportunityRank bucket, flagging thin cells as insufficientSamples', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-bucket-test-${Date.now()}.json`);
  const { recordScan, evaluateOutcomes, buildHitRateReport } = freshScanHistoryService(scratchPath);

  // 12 samples at opportunityRank 85 ("80-100" bucket) - enough to cross MIN_SAMPLES_FOR_MEASURED_DISPLAY (10).
  const deltas = [-20, -15, -5, -2, 0, 3, 5, 8, 10, 12, 15, 20];
  for (let index = 0; index < deltas.length; index += 1) {
    await recordScan({
      exchange: 'NASDAQ',
      strategy: 'ross_cameron', // 5-day horizon, easy to backdate past
      risk: 'medium',
      results: [{ ticker: `HB${index}`, price: 100, opportunityRank: 85 }],
      spyPriceAtScan: 500
    });
  }

  // 5 samples at opportunityRank 45 ("40-59" bucket) for the same strategy - stays below the threshold.
  for (let index = 0; index < 5; index += 1) {
    await recordScan({
      exchange: 'NASDAQ',
      strategy: 'ross_cameron',
      risk: 'medium',
      results: [{ ticker: `LB${index}`, price: 100, opportunityRank: 45 }],
      spyPriceAtScan: 500
    });
  }

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  for (const scan of raw.scans) {
    // Past the 5-day ross_cameron horizon, inside the 90-day league/breakdown window.
    scan.scannedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  }
  fs.writeFileSync(scratchPath, JSON.stringify(raw, null, 2));

  const marketDataService = require('../src/services/marketDataService');
  const originalGetStockSnapshot = marketDataService.getStockSnapshot;
  marketDataService.getStockSnapshot = async (ticker) => {
    if (ticker === 'SPY') return { price: 500 }; // flat benchmark
    const match = ticker.match(/^HB(\d+)$/);
    if (match) {
      return { price: 100 + deltas[Number(match[1])] };
    }
    return { price: 100 }; // LB* tickers: flat
  };

  await evaluateOutcomes({ now: new Date() });
  const report = await buildHitRateReport();

  marketDataService.getStockSnapshot = originalGetStockSnapshot;
  fs.unlinkSync(scratchPath);
  delete process.env.SCAN_HISTORY_FILE_PATH;

  const highBucket = report.byStrategyAndBucket.byStrategy.ross_cameron['80-100'];
  const lowBucket = report.byStrategyAndBucket.byStrategy.ross_cameron['40-59'];

  assert.equal(report.byStrategyAndBucket.minSamplesForMeasuredDisplay, 10);
  assert.equal(highBucket.count, 12);
  assert.equal(highBucket.medianReturnPct, 4); // sorted deltas, median of 12 values -> avg(3, 5)
  assert.equal(highBucket.worstReturnPct, -20);
  assert.equal(highBucket.pctBelowMinus10, 16.7); // 2 of 12 below -10%
  assert.equal(highBucket.insufficientSamples, false);

  assert.equal(lowBucket.count, 5);
  assert.equal(lowBucket.insufficientSamples, true);
});

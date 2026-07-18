const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshModules(scratchPath) {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  process.env.SCAN_HISTORY_FILE_PATH = scratchPath;
  process.env.SHADOW_SCAN_EXCHANGES = 'NASDAQ';

  delete require.cache[require.resolve('../src/services/shadowScanService')];
  delete require.cache[require.resolve('../src/services/scannerService')];
  delete require.cache[require.resolve('../src/services/scanHistoryService')];
  delete require.cache[require.resolve('../src/services/scanHistoryStore')];

  return {
    shadowScanService: require('../src/services/shadowScanService'),
    scannerService: require('../src/services/scannerService'),
    scanHistoryService: require('../src/services/scanHistoryService')
  };
}

function cleanup(scratchPath) {
  fs.rmSync(scratchPath, { force: true });
  delete process.env.SCAN_HISTORY_FILE_PATH;
  delete process.env.SHADOW_SCAN_EXCHANGES;
  delete process.env.SHADOW_SCAN_ENABLED;
}

// A Tuesday, so the weekend skip doesn't interfere.
const TRADING_DAY = new Date('2026-07-14T23:00:00Z');

test('runShadowScans records a scheduled scan for each primary strategy', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-shadow-test-${Date.now()}.json`);
  const { shadowScanService, scannerService, scanHistoryService } = freshModules(scratchPath);

  // Mocking analyzeMarket (rather than relying on demo-data eligibility, which can legitimately
  // yield zero quality setups for a strategy like small_cap_breakout) isolates what this test
  // actually cares about: shadowScanService's own orchestration - which strategies/exchanges it
  // calls and that it tags the resulting scan as 'scheduled'.
  const calls = [];
  scannerService.analyzeMarket = async (request) => {
    calls.push(request);
    await scanHistoryService.recordScan({
      exchange: request.exchange,
      strategy: request.strategy,
      risk: request.risk,
      results: [{ ticker: `${request.strategy}_PICK`, price: 10, opportunityRank: 50 }],
      spyPriceAtScan: 500,
      source: request.scanSource
    });
    return { results: [], meta: {} };
  };

  const { ranCount } = await shadowScanService.runShadowScans({ now: TRADING_DAY });

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  const scheduledScans = raw.scans.filter((scan) => scan.source === 'scheduled');

  cleanup(scratchPath);

  assert.equal(ranCount, 2);
  assert.deepEqual(calls.map((call) => call.strategy).sort(), ['small_cap_breakout', 'swing_momentum']);
  assert.ok(calls.every((call) => call.exchange === 'NASDAQ' && call.risk === 'medium'));
  assert.equal(scheduledScans.length, 2);
  assert.deepEqual(scheduledScans.map((scan) => scan.strategy).sort(), ['small_cap_breakout', 'swing_momentum']);
});

test('SHADOW_SCAN_ENABLED=false records nothing', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-shadow-disabled-test-${Date.now()}.json`);
  const { shadowScanService, scannerService } = freshModules(scratchPath);
  process.env.SHADOW_SCAN_ENABLED = 'false';

  let called = false;
  scannerService.analyzeMarket = async () => {
    called = true;
    return { results: [], meta: {} };
  };

  const { ranCount, skipped } = await shadowScanService.runShadowScans({ now: TRADING_DAY });
  const exists = fs.existsSync(scratchPath);

  cleanup(scratchPath);

  assert.equal(ranCount, 0);
  assert.equal(skipped, 'disabled');
  assert.equal(called, false);
  assert.equal(exists, false);
});

test('runShadowScans skips weekends', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-shadow-weekend-test-${Date.now()}.json`);
  const { shadowScanService, scannerService } = freshModules(scratchPath);

  let called = false;
  scannerService.analyzeMarket = async () => {
    called = true;
    return { results: [], meta: {} };
  };

  const saturday = new Date('2026-07-11T12:00:00Z');
  const { ranCount, skipped } = await shadowScanService.runShadowScans({ now: saturday });

  cleanup(scratchPath);

  assert.equal(ranCount, 0);
  assert.equal(skipped, 'weekend');
  assert.equal(called, false);
});

test('a failure on one strategy does not stop the other from running', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-shadow-partial-fail-test-${Date.now()}.json`);
  const { shadowScanService, scannerService, scanHistoryService } = freshModules(scratchPath);

  scannerService.analyzeMarket = async (request) => {
    if (request.strategy === 'swing_momentum') {
      throw new Error('simulated provider outage');
    }
    await scanHistoryService.recordScan({
      exchange: request.exchange,
      strategy: request.strategy,
      risk: request.risk,
      results: [{ ticker: 'SC_PICK', price: 10, opportunityRank: 50 }],
      spyPriceAtScan: 500,
      source: request.scanSource
    });
    return { results: [], meta: {} };
  };

  const { ranCount, runs } = await shadowScanService.runShadowScans({ now: TRADING_DAY });

  cleanup(scratchPath);

  assert.equal(ranCount, 1);
  assert.equal(runs.find((run) => run.strategy === 'swing_momentum').ok, false);
  assert.equal(runs.find((run) => run.strategy === 'small_cap_breakout').ok, true);
});

test('manual analyzeMarket scans (no scanSource) are not tagged with a source field', async () => {
  const scratchPath = path.join(os.tmpdir(), `scanHistory-shadow-manual-test-${Date.now()}.json`);
  const { scannerService } = freshModules(scratchPath);

  await scannerService.analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'medium', filters: {} });

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));

  cleanup(scratchPath);

  assert.equal(raw.scans.length, 1);
  assert.equal('source' in raw.scans[0], false);
});

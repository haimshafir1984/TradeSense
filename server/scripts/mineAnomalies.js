#!/usr/bin/env node
// CLI entry point for anomaly mining (docs/SPEC_ANOMALY_MINING.md). Usage:
//   node scripts/mineAnomalies.js [--exchange=NASDAQ] [--refresh-bars] [--threshold=12]
// Not reachable from the running app - no route, no scheduler calls this. Deliberately slow
// (network + a full-year scan), which is why it's a script and not an endpoint.
const path = require('path');
const fs = require('fs/promises');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { runResearch, persistPatterns, renderReport } = require('../src/services/research/anomalyResearchService');

function parseArgs(argv) {
  const args = { exchange: 'NASDAQ', refreshBars: false, thresholdPct: undefined };
  for (const arg of argv) {
    if (arg === '--refresh-bars') {
      args.refreshBars = true;
    } else if (arg.startsWith('--exchange=')) {
      args.exchange = arg.split('=')[1].toUpperCase();
    } else if (arg.startsWith('--threshold=')) {
      args.thresholdPct = Number(arg.split('=')[1]);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = { exchange: args.exchange, refreshBars: args.refreshBars };
  if (Number.isFinite(args.thresholdPct)) {
    options.thresholdPct = args.thresholdPct;
  }

  console.log(`[mineAnomalies] Starting: exchange=${options.exchange} refreshBars=${options.refreshBars} threshold=${options.thresholdPct ?? '(default)'}`);

  const result = await runResearch(options);

  console.log(
    `[mineAnomalies] Universe: ${result.symbolCountConsidered} symbols in cap range, ${result.symbolCountWithData} with bar data.`
  );
  console.log(`[mineAnomalies] Feed used: ${result.feed}`);
  console.log(`[mineAnomalies] Samples: ${result.totalSamples} total (${result.inSampleCount} in-sample / ${result.holdoutCount} holdout).`);
  console.log(`[mineAnomalies] Base rate: in-sample ${(result.baseRateInSample * 100).toFixed(2)}%, holdout ${(result.baseRateHoldout * 100).toFixed(2)}%.`);
  console.log(`[mineAnomalies] Patterns surviving holdout gate: ${result.survived.length} (rejected at holdout: ${result.rejectedAtHoldout.length}).`);

  await persistPatterns(result);

  const reportPath = path.resolve(__dirname, '../../docs/ANOMALY_FINDINGS.md');
  await fs.writeFile(reportPath, renderReport(result));
  console.log(`[mineAnomalies] Report written to ${reportPath}`);
}

main().catch((error) => {
  console.error(`[mineAnomalies] Failed: ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node
// CLI entry point for the ledger backfill (docs/SPEC_V2_ARCHITECTURE.md §5.8). Usage:
//   node scripts/runLedgerBackfill.js [--playbook=pead_drift] [--months=24] [--limit=150] [--exchange=NASDAQ]
// Manual only - never called automatically by anything in the running app.
const path = require('path');
const fs = require('fs/promises');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { runBackfill, renderReport, SUPPORTED_PLAYBOOK_KEYS } = require('../src/ledger/backfill');

function parseArgs(argv) {
  const args = { exchange: 'NASDAQ', months: 24, limit: undefined, playbookKeys: SUPPORTED_PLAYBOOK_KEYS };
  for (const arg of argv) {
    if (arg.startsWith('--exchange=')) {
      args.exchange = arg.split('=')[1].toUpperCase();
    } else if (arg.startsWith('--months=')) {
      args.months = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--playbook=')) {
      args.playbookKeys = [arg.split('=')[1]];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[ledger:backfill] Starting: exchange=${args.exchange} months=${args.months} playbooks=${args.playbookKeys.join(',')}` +
      (args.limit ? ` limit=${args.limit}` : '')
  );

  const result = await runBackfill({
    exchange: args.exchange,
    months: args.months,
    playbookKeys: args.playbookKeys,
    ...(args.limit ? { limit: args.limit } : {}),
    onProgress: (message) => console.log(`[ledger:backfill] ${message}`)
  });

  const reportPath = path.resolve(__dirname, '../../docs/BACKFILL_FINDINGS.md');
  await fs.writeFile(reportPath, renderReport({ ...result, exchange: args.exchange, months: args.months }), 'utf8');

  console.log('');
  console.log(`[ledger:backfill] ${result.written.length} trades written this run (${result.symbolsScanned} symbols scanned).`);
  for (const [key, { status, stats }] of Object.entries(result.statsByPlaybook)) {
    console.log(`[ledger:backfill] ${key}: status=${status} holdout.n=${stats.backfill.holdout.n} inSample.n=${stats.backfill.inSample.n}`);
  }
  if (result.skippedKeys.length) {
    console.log(`[ledger:backfill] Skipped (no historical catalyst reconstruction yet): ${result.skippedKeys.join(', ')}`);
  }
  console.log(`[ledger:backfill] Report written to ${reportPath}`);
}

main().catch((error) => {
  console.error(`[ledger:backfill] Failed: ${error.message}`);
  process.exit(1);
});

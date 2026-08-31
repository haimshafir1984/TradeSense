#!/usr/bin/env node
// CLI entry point for resolving outstanding ledger entries against real price data
// (docs/SPEC_V2_ARCHITECTURE.md §5.7). Same logic the API's POST /api/ledger/resolve calls
// (wired in phase 8) - this is the manual/cron-free way to run it locally. Usage:
//   node scripts/runLedgerResolve.js
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { resolveAll } = require('../src/ledger/outcomeResolver');

async function main() {
  console.log('[ledger:resolve] Resolving unresolved ledger entries...');
  const results = await resolveAll();

  const closed = results.filter((entry) => entry.outcome.exitReason !== 'open');
  console.log(`[ledger:resolve] Processed ${results.length} entries (${closed.length} newly closed).`);
  for (const entry of closed) {
    console.log(`[ledger:resolve]   ${entry.ticker} (${entry.playbook}): ${entry.outcome.exitReason}, R=${entry.outcome.rMultiple}`);
  }
}

main().catch((error) => {
  console.error(`[ledger:resolve] Failed: ${error.message}`);
  process.exit(1);
});

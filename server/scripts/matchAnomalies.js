#!/usr/bin/env node
// CLI entry point for matching saved anomaly patterns against today's data
// (docs/SPEC_ANOMALY_MINING.md section 7.3). Usage:
//   node scripts/matchAnomalies.js [--refresh-bars]
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { runMatch } = require('../src/services/research/anomalyResearchService');

function parseArgs(argv) {
  return { refreshBars: argv.includes('--refresh-bars') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runMatch({ refreshBars: args.refreshBars });

  if (result.message) {
    console.log(`[matchAnomalies] ${result.message}`);
    return;
  }

  console.log(`[matchAnomalies] Patterns saved from run at ${result.generatedAt} (${result.exchange}):`);
  console.log('');

  for (const { pattern, matchingSymbols } of result.patterns) {
    const holdout = pattern.holdout;
    console.log(`[${pattern.label} | holdout: ${(holdout.p * 100).toFixed(1)}% on ${holdout.n} occurrences | lift ${holdout.lift.toFixed(2)}]`);
    if (matchingSymbols.length === 0) {
      console.log('  (no symbols currently match)');
    } else {
      for (const match of matchingSymbols) {
        const featureSummary = pattern.conditions
          .map((c) => `${c.feature}=${Number(match.features[c.feature]).toFixed(3)} (bin ${c.bin})`)
          .join('  ');
        console.log(`  ${match.symbol}  ${featureSummary}`);
      }
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error(`[matchAnomalies] Failed: ${error.message}`);
  process.exit(1);
});

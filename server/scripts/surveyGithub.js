#!/usr/bin/env node
// CLI entry point for the public-GitHub survey (docs/SPEC_GITHUB_SURVEY.md). Usage:
//   node scripts/surveyGithub.js [--min-stars=150] [--max-age-days=540]
// Not reachable from the running app - no route, no scheduler calls this. Deliberately slow
// (rate-limited network calls), which is why it's a script and not an endpoint.
const path = require('path');
const fs = require('fs/promises');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { runSurvey, renderReport } = require('../src/services/research/githubSurveyService');

function parseArgs(argv) {
  const args = { minStars: 150, maxAgeDays: 540 };
  for (const arg of argv) {
    if (arg.startsWith('--min-stars=')) {
      args.minStars = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--max-age-days=')) {
      args.maxAgeDays = Number(arg.split('=')[1]);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;

  console.log(
    `[surveyGithub] Starting: minStars=${args.minStars} maxAgeDays=${args.maxAgeDays} ` +
      `auth=${token ? 'token' : 'none (slower, lower quota)'}`
  );

  const survey = await runSurvey({
    minStars: args.minStars,
    maxAgeDays: args.maxAgeDays,
    token,
    onProgress: (message) => console.log(`[surveyGithub] ${message}`)
  });

  const reportPath = path.resolve(__dirname, '../../docs/GITHUB_SURVEY.md');
  await fs.writeFile(reportPath, renderReport(survey), 'utf8');

  const flagged = survey.repositories.filter((repo) => repo.flags.length > 0).length;
  console.log('');
  console.log(`[surveyGithub] ${survey.repositories.length} unique repositories (${flagged} carry at least one warning flag).`);
  console.log(`[surveyGithub] Report written to ${reportPath}`);
  console.log('[surveyGithub] Metadata only - no code was read. See section 5 of the report before drawing conclusions.');
}

main().catch((error) => {
  console.error(`[surveyGithub] Failed: ${error.message}`);
  process.exit(1);
});

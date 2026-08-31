// Historical backfill (docs/SPEC_V2_ARCHITECTURE.md §5.8) - the same chronological-holdout
// method the project's own anomaly miner already proved out, reused here to turn a 3-month wait
// for 30 forward trades into hundreds of historical trades in minutes.
//
// Backtest evidence is weaker than forward evidence by design (§5.8): survivorship bias (today's
// universe isn't the universe that existed back then), the rules were written with knowledge of
// the literature rather than tuned blind, and there's no real slippage. It can promote a playbook
// as far as 'backtested', never further - playbookStats.js enforces that ceiling, not this file.
const { computeFeaturesFromBars } = require('../playbooks/features.js');
const { resolveOutcomeFromBars } = require('./outcomeResolver');

// Minimum bars-before-decision-day required before evaluating a day at all - keeps every decision
// consistent with liquidityGate's own 200-bar floor, so backfill evidence and live evidence are
// measuring the same eligibility bar.
const MIN_HISTORY_BARS = 200;

// Only these two playbooks run in backfill today. gap_continuation needs a day-by-day historical
// reconstruction of news/earnings-schedule catalysts that the free Finnhub tier can't support
// cheaply over hundreds of symbols x hundreds of days - it stays at 'hypothesis' until that's
// built, which is an honest, disclosed limitation (see docs/BACKFILL_FINDINGS.md), not a silent
// gap. opening_range_breakout needs intraday bars (phase 9).
const SUPPORTED_PLAYBOOK_KEYS = ['pead_drift', 'short_term_reversal'];

function monthsAgo(months, from = new Date()) {
  const date = new Date(from);
  date.setMonth(date.getMonth() - months);
  return date;
}

// §5.8's chronological split: thresholds are fixed calendar boundaries, computed once per run
// (not per symbol) so every symbol's trades are split consistently against the same dates.
function computeSplitBoundaries(now = new Date()) {
  return {
    inSampleStart: monthsAgo(24, now),
    holdoutStart: monthsAgo(6, now),
    now
  };
}

function periodForDate(decisionDate, boundaries) {
  const time = decisionDate.getTime();
  if (time < boundaries.inSampleStart.getTime()) {
    return null; // older than the whole backfill window - shouldn't happen given how bars are sliced
  }
  return time >= boundaries.holdoutStart.getTime() ? 'holdout' : 'in_sample';
}

// Reconstructs, purely from a symbol's own historical earnings-surprise list, what
// catalystService would have said "as of" a given decision day - anti-lookahead by construction:
// only surprises whose period is on or before the decision day are ever considered, and
// daysSinceEarnings is computed relative to that same day, never today's real date.
function reconstructPeadCatalyst(surprises, decisionDate) {
  if (!Array.isArray(surprises) || !surprises.length) {
    return null;
  }

  const decisionTime = decisionDate.getTime();
  const knownSurprises = surprises.filter((entry) => new Date(entry.period).getTime() <= decisionTime);
  if (!knownSurprises.length) {
    return null;
  }

  const mostRecent = knownSurprises.reduce((latest, entry) =>
    new Date(entry.period).getTime() > new Date(latest.period).getTime() ? entry : latest
  );

  const daysSinceEarnings = Math.round((decisionTime - new Date(mostRecent.period).getTime()) / (24 * 60 * 60 * 1000));

  return {
    kind: 'earnings_surprise',
    earningsSurprisePct: mostRecent.surprisePercent,
    daysSinceEarnings,
    newsCount48h: null,
    premarketGapPct: null,
    confidence: 'high'
  };
}

// Pure core: walks one symbol's full daily bar history day by day, evaluating every registered
// backfill-supported playbook at every eligible day, and resolving each trade's outcome
// immediately from the bars that already exist after that day (no separate resolver pass needed -
// the whole future is already in hand for a historical run). Anti-lookahead by construction: day i
// only ever sees bars[0..i] for its decision and bars[i+1..] for its resolution, both slices of
// the same fixed array.
function runBackfillForSymbol({ symbol, bars, playbooks, surprises, boundaries }) {
  const entries = [];
  if (!Array.isArray(bars) || bars.length < MIN_HISTORY_BARS + 1) {
    return entries;
  }

  // Only evaluate days that fall inside the backfill window at all - skip the (potentially long)
  // warm-up region before in-sample even starts.
  for (let index = MIN_HISTORY_BARS - 1; index < bars.length - 1; index += 1) {
    const decisionBars = bars.slice(0, index + 1);
    const decisionDate = new Date(decisionBars[decisionBars.length - 1].t);

    if (decisionDate.getTime() < boundaries.inSampleStart.getTime()) {
      continue;
    }

    const period = periodForDate(decisionDate, boundaries);
    if (!period) {
      continue;
    }

    const features = computeFeaturesFromBars(decisionBars);
    // rvol isn't part of features.js's output (that's pipeline/selectionService.js's job, which
    // ranks a whole shortlist against each other) - backfill only has one symbol at a time, so it
    // computes the same rvolDaily formula directly here instead of pulling in the ranking layer.
    const rvol =
      Number.isFinite(features.volume) && Number.isFinite(features.avgVolume14d) && features.avgVolume14d > 0
        ? features.volume / features.avgVolume14d
        : null;

    const stock = { symbol, ...features, rvol };
    // Only reconstructed when the caller supplied this symbol's earnings history (pead_drift is
    // in the playbooks list) - cheap no-op otherwise.
    if (surprises) {
      stock.catalyst = reconstructPeadCatalyst(surprises, decisionDate);
    }

    for (const playbook of playbooks) {
      const result = playbook.evaluate(stock, {});
      if (!result.eligible || !result.plan?.valid) {
        continue;
      }

      const futureBars = bars.slice(index + 1);
      const outcome = resolveOutcomeFromBars(result.plan, futureBars);
      if (!outcome || outcome.exitReason === 'open') {
        // Not enough future history in this backfill window to know how the trade ended - skip
        // rather than record a trade with an unknowable outcome.
        continue;
      }

      entries.push({
        ticker: symbol,
        playbook: playbook.key,
        riskTier: null,
        featuresAtDecision: stock,
        plan: result.plan,
        regimeAtDecision: null,
        source: 'backfill',
        period,
        createdAt: decisionDate.toISOString(),
        outcome
      });
    }
  }

  return entries;
}

// Caps how many universe symbols get scanned, ranked by avgDollarVolume - same convention as
// universeBuilderService.js's own enrich limit. Keeps runtime and Finnhub call volume bounded
// (pead_drift needs one getEarningsSurprises call per symbol, throttled at 50/min - see
// providers/finnhubService.js).
const DEFAULT_SYMBOL_LIMIT = 150;
const BAR_HISTORY_BUFFER_DAYS = 40; // extra calendar days beyond `months` so MIN_HISTORY_BARS of
// warm-up is available even for the earliest in-sample decision day.

const alpacaService = require('../providers/alpacaService');
const finnhubService = require('../providers/finnhubService');
const universeBuilderService = require('../services/universeBuilderService');
const ledgerStore = require('./ledgerStore');
const { getPlaybook } = require('../playbooks/index');
const { computePlaybookStats, determineStatus } = require('./playbookStats');

async function fetchSurprisesForSymbols(symbols, onProgress) {
  const bySymbol = new Map();
  let done = 0;

  for (const symbol of symbols) {
    const surprises = await finnhubService.getEarningsSurprises(symbol);
    bySymbol.set(symbol, surprises);
    done += 1;
    if (onProgress && done % 25 === 0) {
      onProgress(`  earnings history: ${done}/${symbols.length}`);
    }
  }

  return bySymbol;
}

// The full run: universe -> bars -> (earnings history if pead_drift requested) -> per-symbol
// backfill -> persisted to the ledger. Returns the entries written plus the per-playbook stats
// computed from the WHOLE ledger (so a second run's numbers reflect everything backfilled so far,
// not just this run) - report rendering is the CLI's job, not this function's.
async function runBackfill({
  exchange = 'NASDAQ',
  months = 24,
  playbookKeys = SUPPORTED_PLAYBOOK_KEYS,
  limit = DEFAULT_SYMBOL_LIMIT,
  onProgress
} = {}) {
  const requestedKeys = playbookKeys.filter((key) => SUPPORTED_PLAYBOOK_KEYS.includes(key));
  const skippedKeys = playbookKeys.filter((key) => !SUPPORTED_PLAYBOOK_KEYS.includes(key));
  const playbooks = requestedKeys.map(getPlaybook).filter(Boolean);

  const boundaries = computeSplitBoundaries();
  const universe = await universeBuilderService.getUniverseWithLazyRefresh(exchange);

  if (!universe || !Array.isArray(universe.rows) || !universe.rows.length) {
    return { written: [], skippedKeys, universeCount: 0, symbolsScanned: 0, boundaries, statsByPlaybook: {} };
  }

  const symbols = universe.rows
    .slice()
    .sort((left, right) => (Number(right.avgDollarVolume) || 0) - (Number(left.avgDollarVolume) || 0))
    .slice(0, limit)
    .map((row) => row.symbol);

  if (onProgress) {
    onProgress(`universe: ${universe.rows.length} symbols, scanning top ${symbols.length} by dollar volume`);
  }

  const days = Math.ceil(months * 31) + BAR_HISTORY_BUFFER_DAYS;
  const barsBySymbol = await alpacaService.getDailyBars({ symbols, days });

  const needsSurprises = playbooks.some((playbook) => playbook.key === 'pead_drift');
  const surprisesBySymbol = needsSurprises ? await fetchSurprisesForSymbols(symbols, onProgress) : null;

  const allEntries = [];
  for (const symbol of symbols) {
    const bars = barsBySymbol.get(symbol) || [];
    const surprises = surprisesBySymbol ? surprisesBySymbol.get(symbol) : null;
    const symbolEntries = runBackfillForSymbol({ symbol, bars, playbooks, surprises, boundaries });
    allEntries.push(...symbolEntries);
  }

  const written = allEntries.length ? await ledgerStore.appendEntries(allEntries) : [];

  const allLedgerEntries = await ledgerStore.readEntries();
  const statsByPlaybook = {};
  for (const key of requestedKeys) {
    const stats = computePlaybookStats(allLedgerEntries, key);
    statsByPlaybook[key] = { stats, status: determineStatus(stats) };
  }

  return { written, skippedKeys, universeCount: universe.rows.length, symbolsScanned: symbols.length, boundaries, statsByPlaybook };
}

function formatStatBlock(label, stats) {
  if (stats.n === 0) {
    return `${label}: אין עסקאות (n=0)`;
  }
  return (
    `${label}: n=${stats.n}, hit-rate=${stats.hitRatePct}%, ממוצע R=${stats.avgR}, ` +
    `חציון R=${stats.medianR}, MAE ממוצע=${stats.avgMaePct}%, profit factor=${stats.profitFactor ?? '—'}`
  );
}

// Renders docs/BACKFILL_FINDINGS.md (§5.8: CLI-owned, overwritten every run). The universe-
// survivorship-bias warning and the skipped-playbooks disclosure are mandatory, not optional -
// §11 criterion 6.
function renderReport({ written, skippedKeys, universeCount, symbolsScanned, boundaries, statsByPlaybook, exchange, months }) {
  const lines = [];

  lines.push('# ממצאי מילוי היסטורי (Backfill) — TradeSense v2');
  lines.push('');
  lines.push(`תאריך ריצה: ${new Date().toISOString()}`);
  lines.push('מקור: `docs/SPEC_V2_ARCHITECTURE.md` §5.8 — נוצר אוטומטית ע"י `npm run ledger:backfill --workspace server` — נדרס בכל ריצה.');
  lines.push('');
  lines.push(
    '**זו ראיה חלשה יותר מנתונים קדימה, לא תחליף להם.** מילוי היסטורי יכול לקדם פלייבוק עד לדרגת `backtested` בלבד ' +
      '(סולם ארבע הדרגות, §5.8) — לעולם לא ל-`active`, שדורש 30 עסקאות **קדימה** אמיתיות ללא עוקף.'
  );
  lines.push('');

  lines.push('## 1. פרמטרי הריצה');
  lines.push('');
  lines.push(`- בורסה: ${exchange}`);
  lines.push(`- חלון: ${months} חודשים אחורה`);
  lines.push(`- universe: ${universeCount} מניות, נסרקו ${symbolsScanned} (הגבוהות בנפח דולרי)`);
  lines.push(`- חלוקה כרונולוגית: in-sample מ-${boundaries.inSampleStart.toISOString().slice(0, 10)} עד ${boundaries.holdoutStart.toISOString().slice(0, 10)}, holdout מ-${boundaries.holdoutStart.toISOString().slice(0, 10)} עד היום`);
  lines.push(`- עסקאות שנכתבו בריצה זו: ${written.length}`);
  lines.push('');

  lines.push('## 2. מגבלות — לקרוא לפני שמסיקים משהו');
  lines.push('');
  lines.push(
    '1. **הטיית שרידות ב-universe.** הסריקה רצה על ה-universe של **היום**, לא זה שהיה קיים בפועל בכל תאריך היסטורי — ' +
      'מניות שנמחקו/נרכשו/פשטו רגל לא נכללות. זו הטיה אמיתית שמנפחת תוצאות, ואין לה פתרון בנתונים החינמיים.'
  );
  lines.push('2. **החוקים לא כוילו על הנתונים.** הספים בכל פלייבוק נכתבו מראש מהספרות (§5.3), לא הותאמו כדי להיראות טוב כאן.');
  if (skippedKeys.length) {
    lines.push(
      `3. **פלייבוקים שדולגו: ${skippedKeys.join(', ')}.** אין שחזור היסטורי של קטליזטורים (חדשות/דוחות) עבורם בעלות סבירה על נתוני Finnhub החינמיים — נשארים בדרגת \`hypothesis\` עד שזה ייבנה.`
    );
  }
  lines.push('');

  lines.push('## 3. תוצאות לפי פלייבוק');
  lines.push('');
  for (const [key, { stats, status }] of Object.entries(statsByPlaybook)) {
    const playbook = getPlaybook(key);
    lines.push(`### ${playbook ? playbook.label : key}`);
    lines.push('');
    lines.push(`דרגה נוכחית: **${status}**`);
    lines.push('');
    lines.push(`- ${formatStatBlock('In-sample', stats.backfill.inSample)}`);
    lines.push(`- ${formatStatBlock('Holdout', stats.backfill.holdout)}`);
    lines.push(`- ${formatStatBlock('קדימה (forward)', stats.forward)}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  SUPPORTED_PLAYBOOK_KEYS,
  MIN_HISTORY_BARS,
  monthsAgo,
  computeSplitBoundaries,
  periodForDate,
  reconstructPeadCatalyst,
  runBackfillForSymbol,
  runBackfill,
  renderReport
};

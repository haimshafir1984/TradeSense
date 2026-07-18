// On-demand bridge to the separate Vibe-Trading research tool (installed outside this repo, see
// docs/SPEC_VIBE_TRADING_LAB.md and docs/SPEC_VIBE_TRADING_INTEGRATION.md). This is deliberately
// NOT wired into any scan - it only runs when a user clicks "בדוק היסטורית"/"בדוק תאוריה" in the
// UI, and only when VIBE_TRADING_ENABLED=true (default off - this feature does not exist on
// Render, where Vibe-Trading isn't installed).
//
// Fail-soft by design: any missing config, missing executable, or process failure returns
// { ok: false, message } for the UI to show - never throws to the route handler.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const universeStore = require('./universeStore');
const { SMALL_CAP_THRESHOLDS } = require('../config/scoringConfig');

const RUN_TIMEOUT_MS = 3 * 60 * 1000; // Vibe-Trading agent runs take ~30-90s; generous ceiling.

// Same rules as docs/BACKTEST_STRATEGY_DEFINITIONS.md, kept in sync with scoringConfig.js/
// strategies.js by hand (there is no shared source - this is a UI convenience feature, not a
// scoring engine, so a small amount of duplication is acceptable here).
const STRATEGY_RULES = {
  small_cap_breakout: {
    benchmark: 'IWM',
    label: 'מניות קטנות נפיצות (Small-Cap Breakout)',
    ruleText:
      'Eligibility gate: 20-day average daily range (ADR%, average of (high-low)/low*100 over the trailing 20 trading days) must be >= 5%. ' +
      'Entry signal on a given day: max(gap_pct, daily_change_pct) >= 4%, where gap_pct = (open-previous_close)/previous_close*100 and daily_change_pct = (close-previous_close)/previous_close*100; AND volume >= 2x the trailing 30-day average volume; AND close price >= 85% of the trailing 52-week high.'
  },
  swing_momentum: {
    benchmark: 'SPY',
    label: 'פריצות מומנטום (Swing Momentum)',
    ruleText:
      'Eligibility gate: 20-day ADR% (as above) must be >= 3.5%, AND close price must be above the 200-day moving average (MA200). ' +
      'Entry signal (either sub-setup counts): [Breakout] MA50 > MA200 AND close > MA50 AND close >= 85% of the trailing 52-week high AND volume >= 1.5x the trailing 30-day average volume; ' +
      'OR [Episodic Pivot] max(gap_pct, daily_change_pct) >= 8% AND volume >= 2.5x the trailing 30-day average volume.'
  }
};

// Fixed, previously-validated candidate lists (see docs/BACKTEST_FINDINGS.md - an open-ended
// "build your own universe" prompt made the agent loop unproductively for 40 iterations without
// a result; a fixed ticker list works reliably). Kept only as the fallback for when the
// systematic universe below isn't available (docs/SPEC_SHORT_TERM_UPGRADE.md step 8) - the
// BACKTEST_FINDINGS.md report itself flags these as hand-picked, so selection-bias-free is
// strictly better whenever the nightly universe store has usable data.
const THEORY_CHECK_UNIVERSE = {
  small_cap_breakout: 'SMCI, AEHR, CELH, ONON, FUBO, IONQ, RGTI, MARA, RIOT, CLSK, SOUN, BBAI, LAZR, CHPT, PLUG, FCEL, GEVO, RIVN, LCID, NKLA, ACHR, JOBY, UPST, AFRM, SOFI, OPEN, CVNA, BYND, PTON, DKNG, RUM, GRAB, DNA, RXRX, CRSP, NTLA, BEAM, EDIT, SAVA, SRPT',
  swing_momentum: 'AAPL, MSFT, NVDA, AMD, TSLA, META, GOOGL, AMZN, NFLX, CRM, ADBE, ORCL, AVGO, QCOM, INTC, MU, PANW, CRWD, SNOW, PLTR, UBER, ABNB, SHOP, SQ, PYPL, COIN, MSTR, JPM, GS, BAC, V, MA, HD, NKE, SBUX, DIS, BA, CAT, DE, XOM, CVX, LLY, UNH, JNJ, PFE'
};

const SYSTEMATIC_UNIVERSE_SIZE = { small_cap_breakout: 40, swing_momentum: 45 };
const SWING_MOMENTUM_MIN_MARKET_CAP = 10000000000; // large-cap floor, matching the spirit of the old hand-picked list.

// Builds a candidate list from the nightly-refreshed universe store (universeStore.js) instead of
// the hand-picked list above - the single biggest selection-bias caveat in BACKTEST_FINDINGS.md.
// Deterministic (sorted by dollar volume, symbol as a tiebreaker) so repeated runs stay
// comparable. Falls back to the fixed list when the store has nothing usable (empty, or the
// >72h-stale cutoff in universeStore.getUniverse already returns null for that).
async function buildTheoryUniverse(strategyKey) {
  const universe = await universeStore.getUniverse('NASDAQ');
  const fallback = { tickers: THEORY_CHECK_UNIVERSE[strategyKey] || THEORY_CHECK_UNIVERSE.small_cap_breakout, source: 'fixed legacy list' };

  if (!universe || !Array.isArray(universe.rows) || !universe.rows.length) {
    return fallback;
  }

  const limit = SYSTEMATIC_UNIVERSE_SIZE[strategyKey] || SYSTEMATIC_UNIVERSE_SIZE.small_cap_breakout;
  const filtered = universe.rows.filter((row) => {
    if (!Number.isFinite(row?.marketCap) || row.marketCap <= 0) {
      return false;
    }
    if (strategyKey === 'small_cap_breakout') {
      return row.marketCap < SMALL_CAP_THRESHOLDS.marketCapCeiling && Number.isFinite(row.price) && row.price >= SMALL_CAP_THRESHOLDS.minPrice;
    }
    return row.marketCap >= SWING_MOMENTUM_MIN_MARKET_CAP;
  });

  const sorted = filtered
    .slice()
    .sort((left, right) => {
      const leftVolume = Number(left.avgDollarVolume) || 0;
      const rightVolume = Number(right.avgDollarVolume) || 0;
      return rightVolume !== leftVolume ? rightVolume - leftVolume : left.symbol.localeCompare(right.symbol);
    })
    .slice(0, limit);

  if (!sorted.length) {
    return fallback;
  }

  return { tickers: sorted.map((row) => row.symbol).join(', '), source: 'systematic (universeStore)' };
}

function isEnabled() {
  return process.env.VIBE_TRADING_ENABLED === 'true';
}

function getLabPath() {
  return process.env.VIBE_TRADING_LAB_PATH || path.join(os.homedir(), 'Projects', 'vibe-trading-lab');
}

function getExecutablePath() {
  // Windows-only for now - this feature is local-dev-only, never deployed. See spec section on
  // scope for why a cross-platform path resolver wasn't built.
  return path.join(getLabPath(), 'venv', 'Scripts', 'vibe-trading.exe');
}

// Vibe-Trading's own config loader has an initialization-order quirk (see
// docs/SPEC_VIBE_TRADING_INTEGRATION.md) where relying solely on ~/.vibe-trading/.env silently
// falls back to defaults for `run`. The one thing that reliably works is having the vars already
// present in the child process's environment before it starts - so this reads the file ourselves
// and merges it into the spawned process's env, exactly like the shell workaround that was
// validated manually.
// --no-rich stops Rich from *choosing* to colorize, but some CLI output (e.g. the preflight
// check table) still emits raw ANSI escape codes regardless - so strip them ourselves rather
// than depend on the third-party CLI's flag coverage.
function stripAnsiCodes(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function loadDeepSeekEnvOverrides() {
  const envFilePath = path.join(os.homedir(), '.vibe-trading', '.env');
  const overrides = {};

  let raw;
  try {
    raw = fs.readFileSync(envFilePath, 'utf8');
  } catch (error) {
    console.warn(`[vibeTrading] Could not read ${envFilePath}: ${error.message}`);
    return overrides;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) {
      overrides[key] = value;
    }
  }

  return overrides;
}

// Single-flight guard - Vibe-Trading agent runs are heavyweight (spawn a Python process, hold an
// LLM conversation for up to 3 minutes). Running several concurrently from casual UI clicking
// would multiply cost and contend for the same DeepSeek rate limit for no benefit.
let runInFlight = false;

function disabledResponse() {
  return {
    ok: false,
    message: 'תכונת הבדיקה ההיסטורית לא פעילה בסביבה הזו (זמינה רק בפיתוח מקומי עם Vibe-Trading מותקן - ראו docs/SPEC_VIBE_TRADING_INTEGRATION.md).'
  };
}

async function runPrompt(promptText) {
  if (!isEnabled()) {
    return disabledResponse();
  }

  if (runInFlight) {
    return { ok: false, message: 'בדיקה אחרת כבר רצה - נסה שוב בעוד רגע.' };
  }

  const executable = getExecutablePath();
  if (!fs.existsSync(executable)) {
    return {
      ok: false,
      message: `Vibe-Trading לא נמצא ב-${executable}. ראו הוראות התקנה ב-docs/SPEC_VIBE_TRADING_LAB.md.`
    };
  }

  runInFlight = true;

  try {
    const childEnv = { ...process.env, ...loadDeepSeekEnvOverrides() };

    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['run', '-p', promptText, '--no-rich'], {
        cwd: getLabPath(),
        env: childEnv
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      const timeoutHandle = setTimeout(() => {
        child.kill();
        reject(new Error(`הבדיקה לא הסתיימה תוך ${RUN_TIMEOUT_MS / 1000} שניות ובוטלה`));
      }, RUN_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          reject(new Error(stripAnsiCodes(stderrBuffer).slice(-800) || `Vibe-Trading exited with code ${code}`));
        } else {
          resolve(stdoutBuffer);
        }
      });
    });

    return { ok: true, report: stripAnsiCodes(stdout) };
  } catch (error) {
    console.warn(`[vibeTrading] run failed: ${error.message}`);
    return { ok: false, message: `הבדיקה נכשלה: ${error.message}` };
  } finally {
    runInFlight = false;
  }
}

function buildStockHistoryPrompt({ ticker, strategy }) {
  const rules = STRATEGY_RULES[strategy] || STRATEGY_RULES.small_cap_breakout;

  return (
    `Write and run ONE complete Python script (write it to a file first, then execute that file - do not explore interactively) that checks the historical behavior of the single stock ${ticker} over the trailing 2 years using yfinance daily data.\n\n` +
    `${rules.ruleText}\n\n` +
    `For every past trading day in the last 2 years where ${ticker} matched this entry signal, compute the forward return at three horizons: 5, 10, and 20 trading days later (percent change in close price from the signal day).\n\n` +
    `Report: the number of times this pattern occurred; for each horizon, the win rate (% positive), average return, median return, and the single best and single worst occurrence with their dates. Also report ${ticker}'s own buy-and-hold return over the same 2-year period for comparison.\n\n` +
    'Do not tune or adjust any of the thresholds above based on the results. Do not enable, configure, or touch any live or paper trading connector or broker - this is a pure historical data check. State the data source used. Keep the final report concise and in plain text/markdown.'
  );
}

function buildTheoryPrompt({ strategy, universeTickers }) {
  const rules = STRATEGY_RULES[strategy] || STRATEGY_RULES.small_cap_breakout;

  return (
    `Write and run ONE complete Python script (write it to a file first, then execute that file - do not explore interactively) that backtests a swing-trading rule over the trailing 3 years using yfinance daily data.\n\n` +
    `CANDIDATE UNIVERSE (use exactly this fixed list - do not fetch a broader universe): ${universeTickers}\n\n` +
    `${rules.ruleText}\n\n` +
    'For every signal day found, simulate three trades entering at that close and exiting at the close 5, 10, and 20 trading days later.\n\n' +
    `Also download ${rules.benchmark} over the same period as a benchmark (buy-and-hold).\n\n` +
    'For each of the three horizons report: number of signals, win rate, average return per trade (also report a non-compounded sum/count average alongside any compounded cumulative figure, since compounding many trades can produce a misleadingly large number), median return per trade, max drawdown, and the benchmark comparison.\n\n' +
    'Do not tune or adjust any of the thresholds above based on the results - report them as-is. Do not enable, configure, or touch any live or paper trading connector or broker. If yfinance fails for a specific ticker, skip it and continue. State the data source used. Keep the final report concise and in plain text/markdown.'
  );
}

async function checkStockHistory({ ticker, strategy }) {
  return runPrompt(buildStockHistoryPrompt({ ticker, strategy }));
}

async function checkTheory({ strategy }) {
  // Checked here (mirroring runPrompt's own check) before touching the universe store, so a
  // disabled response doesn't pay for a disk read it doesn't need.
  if (!isEnabled()) {
    return disabledResponse();
  }

  const { tickers, source } = await buildTheoryUniverse(strategy);
  const result = await runPrompt(buildTheoryPrompt({ strategy, universeTickers: tickers }));

  if (!result.ok) {
    return result;
  }

  const sourceNote =
    source === 'systematic (universeStore)'
      ? 'מדגם universe: נבנה שיטתית מה-universe הלילי (universeStore) - לא רשימה ידנית.'
      : 'מדגם universe: רשימה קבועה שנבחרה ידנית (universeStore הלילי לא היה זמין/מספיק כרגע) - ראו הסתייגות selection bias ב-docs/BACKTEST_FINDINGS.md.';

  return { ...result, report: `${sourceNote}\n\n${result.report}` };
}

module.exports = {
  isEnabled,
  checkStockHistory,
  checkTheory,
  buildTheoryUniverse
};

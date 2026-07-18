// Called as scannerService.analyzeMarket(...) rather than destructured, so tests can monkey-patch
// the export without needing to reload this module (same convention as marketDataService in
// scanHistoryService.js).
const scannerService = require('./scannerService');

// Nightly, unattended runs of the existing scan pipeline so the strategy league
// (scanHistoryService.js) accumulates samples for every strategy even on days the user never
// opens the app or only scans one exchange/strategy manually. This is data collection only - it
// never trades, never shows a recommendation to anyone, and reuses analyzeMarket() end to end so
// scoring logic can't drift between "real" scans and shadow ones. See
// docs/SPEC_SHORT_TERM_UPGRADE.md step 1.
const DEFAULT_RISK = 'medium';
const DEFAULT_EXCHANGES = ['NASDAQ', 'NYSE'];

// Two primary strategies are selected (not five), because analyzeMarket already records top-5
// "shadow" picks for every *other* strategy alongside whichever one is selected (see
// buildStrategyTopPicks in scannerService.js) - so two runs are enough to cover all five
// strategies. small_cap_breakout must be one of them: it's the only way it gets scored against
// its own dedicated (Alpaca) small-cap universe (getSmallCapMarketData) instead of the regular
// mega-cap universe, where its eligibility filter rejects almost everything - see
// docs/SPEC_SMALL_CAP_STRATEGY.md and docs/LOGIC_IMPROVEMENTS.md section 7.1.
const SHADOW_PRIMARY_STRATEGIES = ['swing_momentum', 'small_cap_breakout'];

function isEnabled() {
  return process.env.SHADOW_SCAN_ENABLED !== 'false';
}

function getExchanges() {
  const raw = process.env.SHADOW_SCAN_EXCHANGES;
  if (!raw) {
    return DEFAULT_EXCHANGES;
  }

  const parsed = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_EXCHANGES;
}

// Calendar-day weekend check against the scan's own clock is a simple approximation (no market
// holiday calendar) - good enough to skip the two days a week guaranteed to have no fresh EOD
// data, without inventing a holiday-calendar dependency for a best-effort background job.
function isLikelyTradingDay(date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

async function runShadowScans({ now = new Date() } = {}) {
  if (!isEnabled()) {
    return { ranCount: 0, skipped: 'disabled', runs: [] };
  }

  if (!isLikelyTradingDay(now)) {
    return { ranCount: 0, skipped: 'weekend', runs: [] };
  }

  const runs = [];

  for (const exchange of getExchanges()) {
    for (const strategy of SHADOW_PRIMARY_STRATEGIES) {
      try {
        await scannerService.analyzeMarket({ exchange, strategy, risk: DEFAULT_RISK, scanSource: 'scheduled' });
        runs.push({ exchange, strategy, ok: true });
      } catch (error) {
        console.warn(`[shadowScan] Failed for ${exchange}/${strategy}: ${error.message}`);
        runs.push({ exchange, strategy, ok: false, error: error.message });
      }
    }
  }

  return { ranCount: runs.filter((run) => run.ok).length, runs };
}

module.exports = {
  runShadowScans
};

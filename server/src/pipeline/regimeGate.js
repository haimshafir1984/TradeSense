// Stage 6 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.6) - blocks whole risk tiers, never
// ranks individual stocks. Assessed on SPY only, deliberately simple and measurable.
const alpacaService = require('../providers/alpacaService');
const { computeFeaturesFromBars, computeRealizedVolatility } = require('../playbooks/features.js');

const REGIME_SYMBOL = 'SPY';
const HISTORY_DAYS = 450; // >252 trading days once weekends/holidays are removed - enough for a
// full year of rolling 20-day volatility samples plus the 200-day MA itself.
const VOLATILITY_WINDOW = 20;
const MEDIAN_LOOKBACK_TRADING_DAYS = 252;

// Realized 20-day volatility as of the END of every trailing-year day (a rolling series), so
// "today's vol vs the annual median" is an actual measured comparison and not a guess. Anti-
// lookahead by construction: computeRealizedVolatility(bars.slice(0, i + 1), ...) for index i
// only ever sees bars up to and including i.
function computeRollingVolatilitySeries(bars, window, lookbackTradingDays) {
  const startIndex = Math.max(window, bars.length - lookbackTradingDays);
  const series = [];

  for (let index = startIndex; index < bars.length; index += 1) {
    const vol = computeRealizedVolatility(bars.slice(0, index + 1), window);
    if (vol !== null) {
      series.push(vol);
    }
  }

  return series;
}

function medianOf(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Pure core: given SPY's own daily bars, decide the regime. Split out from assessRegime so tests
// can inject bars directly instead of monkey-patching the provider for every case.
function assessRegimeFromBars(spyBars) {
  const features = computeFeaturesFromBars(spyBars);
  const realizedVol20d = computeRealizedVolatility(spyBars, VOLATILITY_WINDOW);

  if (!Number.isFinite(features.price) || !Number.isFinite(features.ma200) || realizedVol20d === null) {
    // Can't assess - fail toward caution rather than guessing. Blocking the aggressive tier is the
    // safe default when the regime itself is unknown.
    return {
      state: 'neutral',
      spyAboveMa200: null,
      realizedVol20d,
      blockedTiers: ['aggressive'],
      insufficientData: true
    };
  }

  const spyAboveMa200 = features.price > features.ma200;

  if (!spyAboveMa200) {
    return { state: 'risk_off', spyAboveMa200, realizedVol20d, blockedTiers: ['aggressive'], insufficientData: false };
  }

  const volatilitySeries = computeRollingVolatilitySeries(spyBars, VOLATILITY_WINDOW, MEDIAN_LOOKBACK_TRADING_DAYS);
  const medianVol = medianOf(volatilitySeries);
  const belowMedianVol = medianVol !== null && realizedVol20d < medianVol;

  if (belowMedianVol) {
    return { state: 'risk_on', spyAboveMa200, realizedVol20d, blockedTiers: [], insufficientData: false };
  }

  return { state: 'neutral', spyAboveMa200, realizedVol20d, blockedTiers: [], insufficientData: false };
}

async function assessRegime() {
  const bars = await alpacaService.getDailyBars({ symbols: [REGIME_SYMBOL], days: HISTORY_DAYS });
  const spyBars = bars.get(REGIME_SYMBOL) || [];

  return assessRegimeFromBars(spyBars);
}

module.exports = {
  assessRegime,
  assessRegimeFromBars
};

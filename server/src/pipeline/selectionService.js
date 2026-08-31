// Stage 2 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.2) - the layer research says carries
// most of the actual edge (Zarattini/Barbon/Aziz's filtered ORB variant returned 1,637% vs 29%
// unfiltered - the selection filter did nearly all of the work, not the pattern itself).
//
// Pure and synchronous: operates on already-feature-enriched stocks
// (playbooks/features.js#computeFeaturesFromBars output). No I/O here.
const { round } = require('../services/mathUtils');

// Only these two windows are precomputed by features.js today (avgVolume14d/avgVolume20d) -
// anything else degrades to a null rvol rather than silently computing on the wrong window.
const SUPPORTED_WINDOW_FIELDS = { 14: 'avgVolume14d', 20: 'avgVolume20d' };

function rvolDailyFor(stock, window) {
  const field = SUPPORTED_WINDOW_FIELDS[window];
  const avgVolume = field ? stock[field] : null;

  if (!Number.isFinite(stock.volume) || !Number.isFinite(avgVolume) || avgVolume <= 0) {
    return null;
  }

  return stock.volume / avgVolume;
}

// rvolOpening only exists once intraday bars are wired in (§5.2, §10 phase 9 - ORB). Until then a
// stock may already carry it precomputed (e.g. by a future intraday-aware caller); this file never
// computes it itself.
function rvolOpeningFor(stock) {
  return Number.isFinite(stock.rvolOpening) ? stock.rvolOpening : null;
}

// Ranks by rvolOpening when available, otherwise rvolDaily - and returns only the top N. Every
// returned stock carries `rvol` (the value actually used for ranking) and `rvolBasis` ('opening' |
// 'daily') so a caller/UI can label it correctly, plus the mandatory partial-coverage warning
// (§3.1: Alpaca's free iex feed covers only ~4% of real market volume, so this ranks stocks
// relative to each other, not against true market-wide volume).
function rankByRelativeVolume(stocks, { window = 14, topN = 20 } = {}) {
  const ranked = (stocks || [])
    .map((stock) => {
      const opening = rvolOpeningFor(stock);
      const daily = rvolDailyFor(stock, window);
      const rvol = opening !== null ? opening : daily;

      return {
        ...stock,
        rvol: rvol === null ? null : round(rvol, 3),
        rvolBasis: opening !== null ? 'opening' : 'daily',
        rvolWarning: 'נפח יחסי מבוסס על feed חלקי (iex, ~4% מנפח השוק) - יחסי בין מניות בלבד, לא נפח מוחלט.'
      };
    })
    .filter((stock) => stock.rvol !== null)
    .sort((left, right) => right.rvol - left.rvol);

  return ranked.slice(0, topN);
}

module.exports = {
  rankByRelativeVolume
};

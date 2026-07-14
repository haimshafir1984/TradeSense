function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function average(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value));

  if (!filtered.length) {
    return 0;
  }

  return filtered.reduce((total, value) => total + value, 0) / filtered.length;
}

// Moved here (from marketDataService.js) so both marketDataService.js and barsStockBuilder.js can
// use it without a circular require between the two.
function scoreConsolidation(closes, high52, low52) {
  if (!closes.length) {
    return 0.5;
  }

  const localHigh = Math.max(...closes);
  const localLow = Math.min(...closes);
  const range = localHigh && localLow ? (localHigh - localLow) / localHigh : 0.1;
  const yearlyRange = high52 && low52 ? (high52 - low52) / high52 : 0.25;

  return clamp(1 - range / Math.max(yearlyRange, 0.08));
}

module.exports = {
  clamp,
  round,
  average,
  scoreConsolidation
};

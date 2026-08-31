// Stage 0 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.0). Thresholds are sourced from the
// Zarattini/Barbon/Aziz (2024) ORB paper's own universe filter, not tuned on this project's data.
//
// Operates on already-feature-enriched stocks (playbooks/features.js#computeFeaturesFromBars
// output, plus symbol/companyName/marketCap) - pure and synchronous so it's trivial to test without
// touching a provider.
const THRESHOLDS = {
  minPrice: 5,
  minAvgVolume20d: 1000000,
  minAtr14: 0.5,
  minBarCount: 200
};

// Every rejected stock carries an explicit reason (§5.0) - it feeds `diagnostics` in the API
// response so "0 candidates" reads as information, not a mystery.
function applyLiquidityGate(stocks) {
  const passed = [];
  const rejected = [];

  for (const stock of stocks || []) {
    const reason = rejectionReason(stock);
    if (reason) {
      rejected.push({ symbol: stock?.symbol, reason });
    } else {
      passed.push(stock);
    }
  }

  return { passed, rejected };
}

function rejectionReason(stock) {
  if (!stock || !stock.symbol) {
    return 'רשומה לא תקינה (ללא סימול)';
  }
  if (!Number.isFinite(stock.barCount) || stock.barCount < THRESHOLDS.minBarCount) {
    return `פחות מ-${THRESHOLDS.minBarCount} נרות היסטוריה`;
  }
  if (!Number.isFinite(stock.price) || stock.price < THRESHOLDS.minPrice) {
    return `מחיר מתחת ל-${THRESHOLDS.minPrice}$`;
  }
  if (!Number.isFinite(stock.avgVolume20d) || stock.avgVolume20d < THRESHOLDS.minAvgVolume20d) {
    return `נפח יומי ממוצע מתחת ל-${THRESHOLDS.minAvgVolume20d.toLocaleString('en-US')}`;
  }
  if (!Number.isFinite(stock.atr14) || stock.atr14 < THRESHOLDS.minAtr14) {
    return `ATR14 מתחת ל-${THRESHOLDS.minAtr14}$`;
  }

  return null;
}

module.exports = {
  THRESHOLDS,
  applyLiquidityGate
};

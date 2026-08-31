// Stage 0 of the pipeline (docs/SPEC_V2_ARCHITECTURE.md §5.0). Price/ATR14/bar-count thresholds
// are sourced as-is from the Zarattini/Barbon/Aziz (2024) ORB paper's own universe filter, not
// tuned on this project's data - those aren't feed-dependent (they're price levels, not volume).
//
// minAvgVolume20d IS feed-dependent and was rescaled (2026-08-31), per §12 decision 2's own
// warning made concrete by a live measurement: the paper's 1,000,000 threshold assumes full-market
// (SIP) volume, but this project runs on the free `iex` feed, which measured at ~1M/day for MSFT
// against its real ~20-30M/day (~4% of the market - matching IEX's own published market share).
// Applying a SIP-calibrated threshold to iex-only volume rejected nearly the entire universe,
// mega-caps included (a live 1000-symbol scan passed only 19). Rescaled by the same ~25x the
// measurement implies (1,000,000 / 25 = 40,000) - a proportional correction for the feed, not a
// re-tuning of the paper's own liquidity bar. Revisit if/when upgrading to a SIP feed (§12.2).
const THRESHOLDS = {
  minPrice: 5,
  minAvgVolume20d: 40000,
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

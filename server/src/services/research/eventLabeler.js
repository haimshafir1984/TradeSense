// Event labeling and row eligibility for anomaly mining (docs/SPEC_ANOMALY_MINING.md sections
// 1.1, 2.3, 2.4). Kept separate from asOfFeatures.js because eligibility/labeling need to look at
// bars[index + 1] (the next trading day) - the one place in this whole pipeline that's allowed to
// look forward, because it's producing the *label*, not a *feature*.
const { median } = require('../mathUtils');

const DEFAULT_THRESHOLD_PCT = 12;
const ARTIFACT_CHANGE_PCT = 200; // |change| beyond this is treated as a data artifact, not a real move.
const MIN_HISTORY_BARS = 210;
const DEFAULT_MIN_PRICE = 2;
const DEFAULT_MAX_PRICE = 500;
const DEFAULT_MIN_DOLLAR_VOLUME = 1000000;

// Section 2.3: is (symbol, index) allowed into the sample at all, based only on data at-or-before
// `index` (plus the mere existence of a next bar, needed to produce a label - not its value).
function isEligibleRow(bars, index, options = {}) {
  const minHistoryBars = options.minHistoryBars ?? MIN_HISTORY_BARS;
  const minPrice = options.minPrice ?? DEFAULT_MIN_PRICE;
  const maxPrice = options.maxPrice ?? DEFAULT_MAX_PRICE;
  const minDollarVolume = options.minDollarVolume ?? DEFAULT_MIN_DOLLAR_VOLUME;

  if (index < minHistoryBars - 1) {
    return { eligible: false, reason: 'insufficient-history' };
  }
  if (index + 1 >= bars.length) {
    return { eligible: false, reason: 'no-next-bar' };
  }

  const current = bars[index];
  const close = Number(current?.c);
  const volume = Number(current?.v);

  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(volume) || volume === 0) {
    return { eligible: false, reason: 'invalid-bar' };
  }
  if (close < minPrice || close > maxPrice) {
    return { eligible: false, reason: 'price-out-of-range' };
  }

  const dollarVolumes = [];
  for (let i = Math.max(0, index - 19); i <= index; i += 1) {
    const c = Number(bars[i]?.c);
    const v = Number(bars[i]?.v);
    if (Number.isFinite(c) && Number.isFinite(v)) {
      dollarVolumes.push(c * v);
    }
  }
  const medianDollarVolume = median(dollarVolumes);
  if (medianDollarVolume === null || medianDollarVolume < minDollarVolume) {
    return { eligible: false, reason: 'low-dollar-volume' };
  }

  return { eligible: true, reason: null };
}

// Section 1.1/2.4: is bars[index + 1] a >=thresholdPct close-to-close event relative to bars[index]?
// Returns labeled:false (not eligible/unusable) rather than isEvent:false whenever the underlying
// data can't support a trustworthy label - callers must not fall back to treating that as a
// negative example, since "unusable" and "confirmed non-event" are different things.
function labelEvent(bars, index, options = {}) {
  const thresholdPct = options.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const current = bars[index];
  const next = bars[index + 1];

  if (!current || !next) {
    return { labeled: false, isEvent: null, changePct: null, reason: 'missing-bar' };
  }

  const close = Number(current.c);
  const nextClose = Number(next.c);
  const nextVolume = Number(next.v);

  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(nextClose) || nextClose <= 0) {
    return { labeled: false, isEvent: null, changePct: null, reason: 'invalid-price' };
  }
  if (!Number.isFinite(nextVolume) || nextVolume === 0) {
    return { labeled: false, isEvent: null, changePct: null, reason: 'zero-volume' };
  }

  const changePct = ((nextClose - close) / close) * 100;

  if (Math.abs(changePct) > ARTIFACT_CHANGE_PCT) {
    return { labeled: false, isEvent: null, changePct, reason: 'artifact' };
  }

  return { labeled: true, isEvent: changePct >= thresholdPct, changePct, reason: null };
}

module.exports = {
  isEligibleRow,
  labelEvent,
  DEFAULT_THRESHOLD_PCT,
  ARTIFACT_CHANGE_PCT,
  MIN_HISTORY_BARS,
  DEFAULT_MIN_PRICE,
  DEFAULT_MAX_PRICE,
  DEFAULT_MIN_DOLLAR_VOLUME
};

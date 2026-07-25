const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFeaturesAt, computeFeatureRows, FEATURE_NAMES } = require('../src/services/research/asOfFeatures');

// Deterministic pseudo-random generator (mulberry32) so the synthetic bar series is reproducible
// without pulling in a dependency.
function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateBars(count, seed = 42) {
  const random = mulberry32(seed);
  const bars = [];
  let close = 20;
  const start = new Date('2024-01-01T00:00:00Z').getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < count; i += 1) {
    const drift = (random() - 0.48) * 0.06;
    const open = close * (1 + (random() - 0.5) * 0.02);
    close = Math.max(1, open * (1 + drift));
    const high = Math.max(open, close) * (1 + random() * 0.02);
    const low = Math.min(open, close) * (1 - random() * 0.02);
    // Occasional volume spikes so volume-ratio features have real variance to compare.
    const volume = Math.round((random() * 500000 + 100000) * (random() > 0.9 ? 4 : 1));

    bars.push({
      t: new Date(start + i * dayMs).toISOString(),
      o: Number(open.toFixed(4)),
      h: Number(high.toFixed(4)),
      l: Number(low.toFixed(4)),
      c: Number(close.toFixed(4)),
      v: volume
    });
  }

  return bars;
}

test('computeFeaturesAt never reads past index t (anti-lookahead contract)', () => {
  const bars = generateBars(300);
  const checkpoints = [10, 25, 50, 100, 209, 250, 299];

  for (const t of checkpoints) {
    const fromFullArray = computeFeaturesAt(bars, t);
    const slicedArray = bars.slice(0, t + 1);
    const fromSlicedArray = computeFeaturesAt(slicedArray, slicedArray.length - 1);

    assert.deepStrictEqual(
      fromFullArray,
      fromSlicedArray,
      `feature mismatch at t=${t} - future data leaked into a feature`
    );
  }
});

test('computeFeaturesAt is unaffected by appending more bars after t', () => {
  const bars = generateBars(250);
  const t = 150;
  const before = computeFeaturesAt(bars, t);

  const extended = bars.concat(generateBars(50, 99));
  const after = computeFeaturesAt(extended, t);

  assert.deepStrictEqual(before, after);
});

test('computeFeatureRows returns one row per index from minIndex to the end, with all 16 features present', () => {
  const bars = generateBars(220);
  const rows = computeFeatureRows({ bars, minIndex: 209 });

  assert.equal(rows.length, 220 - 209);
  assert.equal(rows[0].index, 209);
  assert.equal(rows[rows.length - 1].index, 219);
  for (const name of FEATURE_NAMES) {
    assert.ok(name in rows[0].features, `missing feature ${name}`);
  }
});

test('dailyChange and gap-based features respond to a known single-day move', () => {
  const bars = generateBars(220);
  const t = bars.length - 1;
  const prevClose = bars[t - 1].c;
  bars[t] = { ...bars[t], o: prevClose * 1.05, c: prevClose * 1.12, h: prevClose * 1.13, l: prevClose * 1.04 };

  const features = computeFeaturesAt(bars, t);
  assert.ok(Math.abs(features.dailyChange - 12) < 0.01);
});

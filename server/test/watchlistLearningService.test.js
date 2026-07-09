const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBreakoutLikelihood, MIN_SAMPLE_SIZE } = require('../src/services/watchlistLearningService');

function outcome(rankScoreAtLog, gapAccuracyPct) {
  return { rankScoreAtLog, gapAccuracyPct };
}

test('computeBreakoutLikelihood reports "not enough data" below the minimum sample size', () => {
  const outcomes = [outcome(0.5, 3), outcome(0.6, -2)]; // fewer than MIN_SAMPLE_SIZE
  const result = computeBreakoutLikelihood({ rankScore: 0.5 }, outcomes);

  assert.equal(result.sampleSize, 2);
  assert.equal(result.minSampleSize, MIN_SAMPLE_SIZE);
  assert.equal(result.positiveGapRatePct, null);
  assert.equal(result.avgGapPct, null);
});

test('computeBreakoutLikelihood ignores outcomes missing rankScoreAtLog or gapAccuracyPct', () => {
  const outcomes = [
    outcome(0.5, 3),
    outcome(0.6, -2),
    outcome(0.55, 4),
    { rankScoreAtLog: null, gapAccuracyPct: 5 }, // missing feature - excluded
    { rankScoreAtLog: 0.5, gapAccuracyPct: undefined } // missing outcome - excluded
  ];

  const result = computeBreakoutLikelihood({ rankScore: 0.5 }, outcomes);

  assert.equal(result.sampleSize, 3); // only the 3 usable entries count toward the sample
  assert.equal(result.positiveGapRatePct, null); // still below MIN_SAMPLE_SIZE
});

test('computeBreakoutLikelihood computes a positive-gap rate and average from the nearest neighbors by rankScore', () => {
  const outcomes = [
    outcome(0.9, 5), // closest to candidate (0.9) - positive
    outcome(0.85, 3), // positive
    outcome(0.8, -4), // negative
    outcome(0.1, 10), // far away, still counted (fewer than NEIGHBOR_COUNT total)
    outcome(0.2, -20) // far away, still counted
  ];

  const result = computeBreakoutLikelihood({ rankScore: 0.9 }, outcomes);

  assert.equal(result.sampleSize, 5);
  assert.equal(result.positiveGapRatePct, 60); // 3 of 5 positive
  assert.equal(result.avgGapPct, -1.2); // (5+3-4+10-20)/5
});

test('computeBreakoutLikelihood only uses the nearest NEIGHBOR_COUNT entries once more than that many are logged', () => {
  // 10 entries far from the candidate's rankScore, plus 8 close ones - only the 8 close ones
  // (NEIGHBOR_COUNT) should be used, all positive, so the rate should be 100%.
  const farOutcomes = Array.from({ length: 10 }, (_, index) => outcome(0.0 + index * 0.001, -50));
  const closeOutcomes = Array.from({ length: 8 }, (_, index) => outcome(0.9 - index * 0.001, 2));

  const result = computeBreakoutLikelihood({ rankScore: 0.9 }, [...farOutcomes, ...closeOutcomes]);

  assert.equal(result.sampleSize, 8);
  assert.equal(result.positiveGapRatePct, 100);
});

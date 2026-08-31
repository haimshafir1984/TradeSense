const test = require('node:test');
const assert = require('node:assert/strict');

const { assessRegimeFromBars } = require('../src/pipeline/regimeGate');

function bar(t, price, wiggle) {
  return { t, o: price, h: price + wiggle, l: price - wiggle, c: price, v: 1000000 };
}

// `phases` is a list of { count, changePerBar, wiggle } segments, applied in order, oldest-first -
// lets tests express "N noisy bars, then M quiet bars" without hand-writing every bar.
function makeSpyBars(phases, startPrice = 400) {
  const bars = [];
  let price = startPrice;
  let day = 0;
  for (const phase of phases) {
    for (let i = 0; i < phase.count; i += 1) {
      day += 1;
      price += phase.changePerBar * (i % 2 === 0 ? 1 : -1) + (phase.drift || 0);
      bars.push(bar(`2026-${String(1 + (day % 12)).padStart(2, '0')}-${String(1 + (day % 27)).padStart(2, '0')}T00:00:00Z`, price, phase.wiggle));
    }
  }
  return bars;
}

test('too little history returns neutral with insufficientData and blocks the aggressive tier', () => {
  const result = assessRegimeFromBars(makeSpyBars([{ count: 5, changePerBar: 1, wiggle: 1 }]));

  assert.equal(result.state, 'neutral');
  assert.equal(result.insufficientData, true);
  assert.deepEqual(result.blockedTiers, ['aggressive']);
});

test('price above MA200 with a quiet recent tail (vol below the annual median) is risk_on and blocks nothing', () => {
  const bars = makeSpyBars([
    { count: 280, changePerBar: 6, wiggle: 6, drift: 0.4 }, // noisy uptrend
    { count: 25, changePerBar: 0.2, wiggle: 0.2, drift: 0.4 } // quiet uptrend tail
  ]);

  const result = assessRegimeFromBars(bars);

  assert.equal(result.spyAboveMa200, true);
  assert.equal(result.state, 'risk_on');
  assert.deepEqual(result.blockedTiers, []);
});

test('price below MA200 is risk_off and blocks the aggressive tier, regardless of volatility', () => {
  const bars = makeSpyBars([
    { count: 250, changePerBar: 0, wiggle: 1, drift: 0 }, // flat around 400
    { count: 10, changePerBar: 0, wiggle: 1, drift: -12 } // sharp decline
  ]);

  const result = assessRegimeFromBars(bars);

  assert.equal(result.spyAboveMa200, false);
  assert.equal(result.state, 'risk_off');
  assert.deepEqual(result.blockedTiers, ['aggressive']);
});

test('price above MA200 with an elevated recent tail (vol at/above the annual median) is neutral, not risk_on', () => {
  const bars = makeSpyBars([
    { count: 280, changePerBar: 0.3, wiggle: 0.3, drift: 0.3 }, // quiet uptrend
    { count: 25, changePerBar: 8, wiggle: 8, drift: 0.3 } // volatile tail
  ]);

  const result = assessRegimeFromBars(bars);

  assert.equal(result.spyAboveMa200, true);
  assert.equal(result.state, 'neutral');
  assert.deepEqual(result.blockedTiers, []);
});

test('regime assessment is anti-lookahead: bars appended after the assessed point never change the result', () => {
  const bars = makeSpyBars([
    { count: 280, changePerBar: 6, wiggle: 6, drift: 0.4 },
    { count: 25, changePerBar: 0.2, wiggle: 0.2, drift: 0.4 }
  ]);
  const extended = [...bars, ...makeSpyBars([{ count: 30, changePerBar: 50, wiggle: 50, drift: -50 }], bars[bars.length - 1].c)];

  const original = assessRegimeFromBars(bars);
  const truncatedFromExtended = assessRegimeFromBars(extended.slice(0, bars.length));

  assert.deepEqual(original, truncatedFromExtended);
});

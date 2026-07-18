const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

function freshVibeTradingService() {
  delete require.cache[require.resolve('../src/services/vibeTradingService')];
  return require('../src/services/vibeTradingService');
}

function clearEnv() {
  delete process.env.VIBE_TRADING_ENABLED;
  delete process.env.VIBE_TRADING_LAB_PATH;
}

test('isEnabled reflects VIBE_TRADING_ENABLED exactly', () => {
  clearEnv();
  const service = freshVibeTradingService();
  assert.equal(service.isEnabled(), false);

  process.env.VIBE_TRADING_ENABLED = 'true';
  assert.equal(service.isEnabled(), true);

  process.env.VIBE_TRADING_ENABLED = 'yes'; // anything other than the literal string 'true' is off
  assert.equal(service.isEnabled(), false);

  clearEnv();
});

test('checkStockHistory returns a disabled message and never spawns a process when the feature is off', async () => {
  clearEnv();
  const service = freshVibeTradingService();

  const result = await service.checkStockHistory({ ticker: 'AAPL', strategy: 'small_cap_breakout' });

  assert.equal(result.ok, false);
  assert.match(result.message, /לא פעילה/);
});

test('checkTheory returns a disabled message when the feature is off', async () => {
  clearEnv();
  const service = freshVibeTradingService();

  const result = await service.checkTheory({ strategy: 'swing_momentum' });

  assert.equal(result.ok, false);
  assert.match(result.message, /לא פעילה/);
});

test('when enabled but the Vibe-Trading executable is missing, returns a clear error instead of throwing', async () => {
  clearEnv();
  process.env.VIBE_TRADING_ENABLED = 'true';
  process.env.VIBE_TRADING_LAB_PATH = path.join(os.tmpdir(), 'nonexistent-vibe-trading-lab-path-for-tests');
  const service = freshVibeTradingService();

  const result = await service.checkStockHistory({ ticker: 'AAPL', strategy: 'small_cap_breakout' });

  clearEnv();

  assert.equal(result.ok, false);
  assert.match(result.message, /לא נמצא/);
});

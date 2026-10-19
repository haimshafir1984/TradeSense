const test = require("node:test");
const assert = require("node:assert/strict");

test("memory pause limits come from the environment and default to 350/300/280 MB", () => {
  const name = require.resolve("../src/memoryDiagnostics");
  const rss = process.memoryUsage().rss / 1024 / 1024;
  delete require.cache[name];
  process.env.MEMORY_PAUSE_OPTIONAL_MB = String(Math.ceil(rss) + 500);
  process.env.MEMORY_PAUSE_SIP_MB = String(Math.ceil(rss) + 400);
  process.env.MEMORY_RESUME_MB = String(Math.ceil(rss) + 300);
  let m = require("../src/memoryDiagnostics");
  m.logMemory();
  assert.equal(m.pressure().optionalPaused, false);
  assert.equal(m.pressure().sipPaused, false);
  // a limit below the current usage pauses optional work
  delete require.cache[name];
  process.env.MEMORY_PAUSE_OPTIONAL_MB = "1";
  m = require("../src/memoryDiagnostics");
  m.logMemory();
  assert.equal(m.pressure().optionalPaused, true);
  for (const k of ["MEMORY_PAUSE_OPTIONAL_MB", "MEMORY_PAUSE_SIP_MB", "MEMORY_RESUME_MB"]) delete process.env[k];
});

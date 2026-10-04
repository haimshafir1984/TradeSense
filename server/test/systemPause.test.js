const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("system pause persists, and a paused tick only records a heartbeat", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-pause-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
  for (const name of ["store", "engine"]) delete require.cache[require.resolve(`../src/autopilot/${name}`)];
  const store = require("../src/autopilot/store");
  const engine = require("../src/autopilot/engine");
  try {
    assert.equal(engine.isSystemPaused(), false);
    engine.setSystemPaused(true);
    assert.equal(engine.isSystemPaused(), true);

    await engine.tick();
    const runtime = store.get("runtime", "engine");
    assert.equal(runtime.paused, true);
    assert.ok(runtime.heartbeatAt);
    assert.equal(runtime.scanning, undefined);

    engine.setSystemPaused(false);
    assert.equal(engine.isSystemPaused(), false);
  } finally {
    store.close();
    delete process.env.AUTOPILOT_DB_PATH;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

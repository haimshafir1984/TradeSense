// Covers the ephemeral-storage detection added after the Render /var/data outage
// (store.js persistenceStatus()): before this, a write failure fell back to tmp storage
// silently - push subscriptions and signal/trade history were lost on every deploy with no
// visible symptom beyond "notifications stopped". This locks in that the fallback is now
// reported, not just logged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function freshStore() {
  delete require.cache[require.resolve("../src/autopilot/store")];
  return require("../src/autopilot/store");
}

test("persistenceStatus reports non-ephemeral when the configured path is writable", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-store-ok-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "autopilot.sqlite");
  const store = freshStore();
  try {
    store.database();
    const status = store.persistenceStatus();
    assert.equal(status.ephemeral, false);
    assert.equal(status.reason, null);
  } finally {
    store.close();
    delete process.env.AUTOPILOT_DB_PATH;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("persistenceStatus reports ephemeral and the reason when the configured path cannot be opened", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-store-fail-"));
  // A plain file where a directory is expected: mkdirSync on its "parent" fails on every OS,
  // simulating the real-world case of /var/data not being an actual mounted, writable directory.
  const blockerFile = path.join(scratch, "blocker");
  fs.writeFileSync(blockerFile, "not a directory");
  process.env.AUTOPILOT_DB_PATH = path.join(blockerFile, "autopilot.sqlite");
  const store = freshStore();
  try {
    store.database();
    const status = store.persistenceStatus();
    assert.equal(status.ephemeral, true);
    assert.match(status.reason, /failed to initialize SQLite/);
    assert.ok(status.file, "ephemeral status should name the fallback file in use");
    assert.notEqual(path.resolve(status.file), path.resolve(process.env.AUTOPILOT_DB_PATH));
    assert.ok(status.detectedAt);
  } finally {
    store.close();
    delete process.env.AUTOPILOT_DB_PATH;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("persistenceStatus resets after close()", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-store-reset-"));
  const blockerFile = path.join(scratch, "blocker");
  fs.writeFileSync(blockerFile, "not a directory");
  process.env.AUTOPILOT_DB_PATH = path.join(blockerFile, "autopilot.sqlite");
  const store = freshStore();
  store.database();
  assert.equal(store.persistenceStatus().ephemeral, true);
  store.close();
  assert.deepEqual(store.persistenceStatus(), { ephemeral: false, reason: null, file: null, detectedAt: null });
  delete process.env.AUTOPILOT_DB_PATH;
  fs.rmSync(scratch, { recursive: true, force: true });
});

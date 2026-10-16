const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-autonomy-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "autonomy.sqlite");
  delete process.env.EXECUTION_AUTONOMY_ENABLED;
  for (const name of ["../src/autopilot/store", "../src/execution/autonomy"]) delete require.cache[require.resolve(name)];
  return { scratch, store: require("../src/autopilot/store"), autonomy: require("../src/execution/autonomy") };
}

function close(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  delete process.env.EXECUTION_AUTONOMY_ENABLED;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

test("autonomy is fail-closed and requires a fresh demo heartbeat", () => {
  const ctx = load();
  try {
    assert.equal(ctx.autonomy.state().mode, "off");
    assert.throws(() => ctx.autonomy.setMode("autonomous"), /אינו מאופשר/);
    process.env.EXECUTION_AUTONOMY_ENABLED = "true";
    assert.throws(() => ctx.autonomy.setMode("autonomous"), /MT4 אינו מחובר/);
    ctx.autonomy.heartbeat({ accountId: "demo-1", agentId: "test-ea", isDemo: true });
    assert.equal(ctx.autonomy.setMode("autonomous").mode, "autonomous");
    ctx.store.put("runtime", "execution-agent", { accountId: "demo-1", isDemo: true, lastSeenAt: new Date(Date.now() - ctx.autonomy.HEARTBEAT_TTL_MS - 1).toISOString() });
    assert.equal(ctx.autonomy.state().mode, "error");
    assert.equal(ctx.autonomy.setMode("scanner").mode, "scanner");
  } finally { close(ctx); }
});

test("non-demo heartbeat is rejected", () => {
  const ctx = load();
  try { assert.throws(() => ctx.autonomy.heartbeat({ accountId: "live-1", isDemo: false }), /אינו מזוהה/); }
  finally { close(ctx); }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function load() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-close-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "close.sqlite");
  process.env.EXECUTION_QUEUE_ENABLED = "true";
  process.env.EXECUTION_BROKER_ACCOUNT_ID = "102992";
  for (const name of ["../src/autopilot/store", "../src/execution/positions", "../src/execution/autonomy", "../src/execution/closeRequests"])
    delete require.cache[require.resolve(name)];
  const store = require("../src/autopilot/store");
  return {
    scratch,
    store,
    positions: require("../src/execution/positions"),
    autonomy: require("../src/execution/autonomy"),
    close: require("../src/execution/closeRequests"),
  };
}

function cleanup(ctx) {
  ctx.store.close();
  delete process.env.AUTOPILOT_DB_PATH;
  delete process.env.EXECUTION_QUEUE_ENABLED;
  delete process.env.EXECUTION_BROKER_ACCOUNT_ID;
  fs.rmSync(ctx.scratch, { recursive: true, force: true });
}

function report(ctx, now, positions = [{ ticket: "20109762", symbol: "Apple#", side: "buy", lots: 10, openPrice: 341.9, managed: true }]) {
  ctx.autonomy.heartbeat({ accountId: "102992", isDemo: true }, now);
  ctx.positions.save({ accountId: "102992", isDemo: true, balance: 10000, equity: 10000, profit: 0, positions }, now);
}

test("creates a pending close request for a fresh, managed demo position and de-duplicates it", () => {
  const ctx = load();
  try {
    const now = Date.now();
    report(ctx, now);
    const first = ctx.close.create({ ticket: "20109762", userId: "u1", now });
    assert.equal(first.request.status, "pending");
    assert.equal(first.duplicate, false);
    const again = ctx.close.create({ ticket: "20109762", userId: "u1", now: now + 1000 });
    assert.equal(again.duplicate, true);
    assert.equal(again.request.id, first.request.id);
    assert.equal(ctx.close.pendingForAccount("102992", now + 1000).length, 1);
    assert.equal(ctx.close.pendingForAccount("999", now + 1000).length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("refuses to queue a close when it is unsafe", () => {
  const ctx = load();
  try {
    const now = Date.now();
    assert.throws(() => ctx.close.create({ ticket: "1", userId: "u1", now }), /MT4 אינו מחובר/);
    report(ctx, now, [
      { ticket: "20109762", symbol: "Apple#", side: "buy", lots: 10, openPrice: 341.9, managed: true },
      { ticket: "555", symbol: "Apple#", side: "buy", lots: 10, openPrice: 341.9, managed: false },
    ]);
    assert.throws(() => ctx.close.create({ ticket: "abc", userId: "u1", now }), /מספר פוזיציה/);
    assert.throws(() => ctx.close.create({ ticket: "777", userId: "u1", now }), /אינה פתוחה/);
    // Manually opened positions of the demo account can be closed from the dashboard too.
    assert.equal(ctx.close.create({ ticket: "555", userId: "u1", now }).request.status, "pending");
    assert.throws(() => ctx.close.create({ ticket: "20109762", userId: "u1", now: now + 200_000 }), /MT4 אינו מחובר|אין דיווח עדכני/);
    process.env.EXECUTION_QUEUE_ENABLED = "false";
    assert.throws(() => ctx.close.create({ ticket: "20109762", userId: "u1", now }), /תור הביצוע כבוי/);
  } finally {
    cleanup(ctx);
  }
});

test("unclaimed requests expire and the EA lifecycle is enforced", () => {
  const ctx = load();
  try {
    const now = Date.now();
    report(ctx, now);
    const { request } = ctx.close.create({ ticket: "20109762", userId: "u1", now });
    assert.equal(ctx.close.pendingForAccount("102992", now + ctx.close.TTL_MS + 1).length, 0);
    assert.equal(ctx.close.get(request.id).status, "expired");
    assert.throws(() => ctx.close.transition(request.id, "claimed"), /מעבר אסור/);

    report(ctx, now + 1000);
    const second = ctx.close.create({ ticket: "20109762", userId: "u1", now: now + 1000 }).request;
    assert.throws(() => ctx.close.transition(second.id, "closed"), /מעבר אסור/);
    assert.equal(ctx.close.transition(second.id, "claimed").status, "claimed");
    const done = ctx.close.transition(second.id, "closed", { closePrice: 342.5 });
    assert.equal(done.status, "closed");
    assert.equal(done.closePrice, 342.5);
    assert.ok(done.completedAt);
  } finally {
    cleanup(ctx);
  }
});

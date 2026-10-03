const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function setup() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-users-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
  delete require.cache[require.resolve("../src/autopilot/store")];
  delete require.cache[require.resolve("../src/autopilot/users")];
  const store = require("../src/autopilot/store");
  const users = require("../src/autopilot/users");
  return {
    store,
    users,
    cleanup() {
      store.close();
      delete process.env.AUTOPILOT_DB_PATH;
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test("reset clears only the code: next login sets a new one and data is untouched", () => {
  const { store, users, cleanup } = setup();
  try {
    const { userId } = users.session({ code: "old-code" });
    store.putUser(userId, "trade", "t1", { id: "t1", ticker: "ABC" });

    assert.deepEqual(users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r1" }), { userId });
    assert.equal(store.get("user", userId).codeHash, null);
    assert.equal(store.getUser(userId, "trade", "t1").ticker, "ABC");

    users.session({ userId, code: "new-code" });
    assert.ok(store.get("user", userId).codeHash);
    assert.equal(store.get("user", userId).codeResetAt, undefined);
    assert.throws(() => users.session({ userId, code: "old-code" }), /לא תואם/);
    assert.equal(users.session({ userId, code: "new-code" }).userId, userId);
    assert.equal(store.getUser(userId, "trade", "t1").ticker, "ABC");
  } finally {
    cleanup();
  }
});

test("the same token is applied once; a new token resets again", () => {
  const { users, cleanup } = setup();
  try {
    const { userId } = users.session({ code: "a" });
    assert.ok(users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r1" }));
    users.session({ userId, code: "b" });
    assert.equal(users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r1" }), null);
    assert.throws(() => users.session({ userId, code: "wrong" }), /לא תואם/);
    assert.ok(users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r2" }));
  } finally {
    cleanup();
  }
});

test("no token means no reset", () => {
  const { users, cleanup } = setup();
  try {
    const { userId } = users.session({ code: "a" });
    assert.equal(users.applyConfiguredReset({}), null);
    assert.throws(() => users.session({ userId, code: "wrong" }), /לא תואם/);
  } finally {
    cleanup();
  }
});

test("'first' targets the oldest profile and leaves the others alone", async () => {
  const { store, users, cleanup } = setup();
  try {
    const first = users.session({ code: "one" }).userId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = users.session({ code: "two" }).userId;
    assert.deepEqual(users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r" }), { userId: first });
    assert.equal(store.get("user", first).codeHash, null);
    assert.ok(store.get("user", second).codeHash);
    assert.throws(() => users.session({ userId: second, code: "wrong" }), /לא תואם/);
  } finally {
    cleanup();
  }
});

test("an explicit profile id is honoured; an unknown id changes nothing and can be retried", () => {
  const { store, users, cleanup } = setup();
  try {
    const first = users.session({ code: "one" }).userId;
    const second = users.session({ code: "two" }).userId;
    assert.equal(
      users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r", AUTOPILOT_CODE_RESET_USER: "missing-id" }),
      null,
    );
    assert.ok(store.get("user", first).codeHash);
    assert.deepEqual(
      users.applyConfiguredReset({ AUTOPILOT_CODE_RESET: "r", AUTOPILOT_CODE_RESET_USER: second }),
      { userId: second },
    );
    assert.equal(store.get("user", second).codeHash, null);
    assert.ok(store.get("user", first).codeHash);
  } finally {
    cleanup();
  }
});

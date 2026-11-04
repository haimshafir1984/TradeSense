const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync, StatementSync } = require("node:sqlite");
const monitor = require("../src/eventLoopMonitor");

const originals = { all: StatementSync.prototype.all, exec: DatabaseSync.prototype.exec };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const block = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

function install(extra = {}) {
  const lines = [];
  monitor.install({ log: (line) => lines.push(line), slowMs: 20, stallMs: 150, requestMs: 50, ...extra });
  return lines;
}

test("install patches and uninstall restores sqlite and is idempotent", () => {
  install();
  assert.notEqual(StatementSync.prototype.all, originals.all);
  assert.equal(monitor.install({}), false);
  monitor.uninstall();
  assert.equal(StatementSync.prototype.all, originals.all);
  assert.equal(DatabaseSync.prototype.exec, originals.exec);
});

test("sql results are unchanged, errors propagate, slow statements are logged", () => {
  const lines = install({ slowMs: 0 });
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(7);
    assert.deepEqual(db.prepare("SELECT a FROM t").all().map((row) => row.a), [7]);
    assert.throws(() => db.prepare("SELECT * FROM missing_table").all());
    assert.ok(lines.some((line) => line.startsWith("[slow-op]") && line.includes("sql.all SELECT a FROM t")));
  } finally {
    monitor.uninstall();
  }
});

test("slow requests are logged and the response is untouched", async () => {
  const express = require("express");
  const app = express();
  app.get("/slow", (_req, res) => {
    block(80);
    res.json({ ok: true });
  });
  const lines = install();
  const { createServer } = require("node:http");
  const server = createServer(app);
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    monitor.uninstall();
    const lines2 = [];
    monitor.install({ app, log: (line) => lines2.push(line), requestMs: 50 });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/slow?x=1`);
    assert.deepEqual(await response.json(), { ok: true });
    await sleep(20);
    assert.ok(lines2.some((line) => line.startsWith("[slow-request] GET /slow ") && !line.includes("x=1")), lines2.join("\n"));
    assert.equal(lines.filter((line) => line.startsWith("[slow-request]")).length, 0);
  } finally {
    monitor.uninstall();
    server.close();
  }
});

test("a blocked event loop is reported with the slow op that caused it", async () => {
  const lines = install({ slowMs: 0 });
  try {
    const db = new DatabaseSync(":memory:");
    await sleep(250);
    db.exec("CREATE TABLE t (a INTEGER)");
    block(400);
    await sleep(250);
    assert.ok(lines.some((line) => line.startsWith("[loop-lag]")), lines.join("\n"));
  } finally {
    monitor.uninstall();
  }
});

test("LOOP_MONITOR=off installs nothing", () => {
  process.env.LOOP_MONITOR = "off";
  try {
    assert.equal(monitor.install({}), false);
    assert.equal(StatementSync.prototype.all, originals.all);
  } finally {
    delete process.env.LOOP_MONITOR;
  }
});

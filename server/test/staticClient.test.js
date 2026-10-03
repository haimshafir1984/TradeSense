const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function load(distDir) {
  if (distDir === undefined) delete process.env.CLIENT_DIST_DIR;
  else process.env.CLIENT_DIST_DIR = distDir;
  delete require.cache[require.resolve("../src/app")];
  return require("../src/app");
}

function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("serves the built client, falls back to index.html, and never shadows /api", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app-shell</html>");
  fs.writeFileSync(path.join(dist, "sw.js"), "// worker");
  const { server, base } = await serve(load(dist));
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /app-shell/);

    const deep = await fetch(`${base}/trades/open`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /app-shell/);

    const worker = await fetch(`${base}/sw.js`);
    assert.equal(worker.headers.get("cache-control"), "no-cache");

    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { ok: true });

    const missingApi = await fetch(`${base}/api/does-not-exist`);
    assert.equal(missingApi.status, 404);
    assert.doesNotMatch(await missingApi.text(), /app-shell/);
  } finally {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
    load(undefined);
  }
});

test("without a built client nothing is served and the API is unchanged", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-nodist-"));
  const { server, base } = await serve(load(empty));
  try {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  } finally {
    server.close();
    fs.rmSync(empty, { recursive: true, force: true });
    load(undefined);
  }
});

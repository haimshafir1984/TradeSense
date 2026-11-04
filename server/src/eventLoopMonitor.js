// Diagnostic only. Finds out what blocks the single Node thread (the cause of the intermittent 502 /
// slow /api/health, see docs/CODEX_502_INVESTIGATION.md) without changing any business code: it wraps
// node:sqlite statements, the autopilot store functions and Express's request dispatch, times them,
// and logs only the slow ones. Every wrapper calls the original with the same arguments and returns or
// throws exactly what it did; logging problems are swallowed. Off with LOOP_MONITOR=off.
//
// Log lines (grep "\[loop"): "[loop-lag]" a stall of the thread, listing the slow operations that
// finished inside it; "[slow-op]" one slow SQL statement / store call / GC pause; "[slow-request]" a
// slow HTTP request (it may simply have waited behind a stall).
const { performance, PerformanceObserver } = require("node:perf_hooks");
const sqlite = require("node:sqlite");

const TICK_MS = 100;
const RING_MAX = 300;
const STORE_FUNCTIONS = ["get", "list", "listIds", "listMetadata", "put", "remove", "getUser", "listUser", "putUser", "removeUser", "transaction", "lease"];

const cfg = { slowMs: 200, stallMs: 1000, requestMs: 1000, maxLogsPerMin: 120, log: (line) => console.warn(line) };
const state = { installed: false, restore: [], timer: null, observer: null, ring: [], logged: 0, suppressed: 0, windowStart: 0, inflight: 0 };

function emit(line) {
  const wall = Date.now();
  if (wall - state.windowStart >= 60000) {
    if (state.suppressed) safeLog(`[loop-monitor] ${state.suppressed} more lines suppressed in the last minute`);
    state.windowStart = wall;
    state.logged = 0;
    state.suppressed = 0;
  }
  if (state.logged >= cfg.maxLogsPerMin) {
    state.suppressed += 1;
    return;
  }
  state.logged += 1;
  safeLog(line);
}

function safeLog(line) {
  try {
    cfg.log(line);
  } catch {
    // Diagnostics must never break the app.
  }
}

function note(label, ms) {
  state.ring.push({ end: Date.now(), ms, label });
  if (state.ring.length > RING_MAX) state.ring.splice(0, state.ring.length - RING_MAX);
  emit(`[slow-op] ${ms.toFixed(0)}ms ${label}`);
}

function safe(fn, fallback = "?") {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Replaces target[name] with a timing wrapper. `describe(thisArg, args)` builds the label only when slow.
function wrap(target, name, describe) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function timed(...args) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      const ms = performance.now() - started;
      if (ms >= cfg.slowMs) safe(() => note(describe(this, args), ms));
    }
  };
  state.restore.push(() => {
    target[name] = original;
  });
}

const sqlText = (value) => String(value).replace(/\s+/g, " ").slice(0, 120);
const firstArg = (args) => (typeof args[0] === "string" ? args[0].slice(0, 60) : "");

function patchSqlite() {
  for (const name of ["all", "get", "run"]) wrap(sqlite.StatementSync.prototype, name, (self) => `sql.${name} ${safe(() => sqlText(self.sourceSQL))}`);
  wrap(sqlite.DatabaseSync.prototype, "exec", (_self, args) => `sql.exec ${sqlText(args[0])}`);
}

function patchStore() {
  const store = require("./autopilot/store");
  for (const name of STORE_FUNCTIONS) wrap(store, name, (_self, args) => `store.${name}(${firstArg(args)})`);
}

function patchApp(app) {
  const original = app.handle;
  if (typeof original !== "function") return;
  app.handle = function timedHandle(req, res, next) {
    const started = performance.now();
    const inflightAtStart = ++state.inflight;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      state.inflight -= 1;
      const ms = performance.now() - started;
      if (ms >= cfg.requestMs) safe(() => emit(`[slow-request] ${req.method} ${String(req.originalUrl || req.url).split("?")[0].slice(0, 80)} ${ms.toFixed(0)}ms status=${res.statusCode} inflight_at_start=${inflightAtStart}`));
    };
    safe(() => {
      res.once("finish", finish);
      res.once("close", finish);
    });
    return original.call(this, req, res, next);
  };
  state.restore.push(() => {
    app.handle = original;
  });
}

function startWatchdog() {
  let expected = Date.now() + TICK_MS;
  state.timer = setInterval(() => {
    const wall = Date.now();
    const lag = wall - expected;
    expected = wall + TICK_MS;
    if (lag < cfg.stallMs) return;
    const stallStart = wall - lag - TICK_MS;
    const during = state.ring.filter((entry) => entry.end >= stallStart - 50).sort((a, b) => b.ms - a.ms).slice(0, 5);
    const detail = during.length
      ? during.map((entry) => `${entry.ms.toFixed(0)}ms ${entry.label}`).join(" | ")
      : "none recorded: blocked outside SQL/store calls (JSON or other CPU work)";
    emit(`[loop-lag] the event loop was blocked ~${lag}ms (ended ${new Date(wall).toISOString()}); slow ops inside it: ${detail}`);
  }, TICK_MS);
  state.timer.unref();
  state.restore.push(() => clearInterval(state.timer));
}

function startGcObserver() {
  try {
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.duration >= cfg.slowMs) safe(() => note(`gc pause (kind ${entry.detail?.kind ?? entry.kind})`, entry.duration));
    });
    state.observer.observe({ entryTypes: ["gc"] });
    state.restore.push(() => state.observer.disconnect());
  } catch {
    // GC timing is optional.
  }
}

function install({ app, log, slowMs, stallMs, requestMs, maxLogsPerMin } = {}) {
  if (process.env.LOOP_MONITOR === "off" || state.installed) return false;
  const fromEnv = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== undefined && process.env[name] !== "" ? Number(process.env[name]) : fallback);
  cfg.log = log || ((line) => console.warn(line));
  cfg.slowMs = slowMs ?? fromEnv("LOOP_MONITOR_SLOW_MS", 200);
  cfg.stallMs = stallMs ?? fromEnv("LOOP_MONITOR_STALL_MS", 1000);
  cfg.requestMs = requestMs ?? fromEnv("LOOP_MONITOR_REQUEST_MS", 1000);
  cfg.maxLogsPerMin = maxLogsPerMin ?? 120;
  state.installed = true;
  patchSqlite();
  patchStore();
  if (app) patchApp(app);
  startWatchdog();
  startGcObserver();
  safeLog(`[loop-monitor] installed: slow op >= ${cfg.slowMs}ms, stall >= ${cfg.stallMs}ms, slow request >= ${cfg.requestMs}ms`);
  return true;
}

function uninstall() {
  while (state.restore.length) safe(() => state.restore.pop()());
  state.installed = false;
  state.ring = [];
  state.logged = 0;
  state.suppressed = 0;
  state.windowStart = 0;
  state.inflight = 0;
  state.timer = null;
  state.observer = null;
}

module.exports = { install, uninstall };

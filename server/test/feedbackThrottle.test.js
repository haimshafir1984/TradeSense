const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AUTOPILOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-throttle-")), "test.sqlite");
const feedback = require("../src/autopilot/feedback");
const recommendations = require("../src/autopilot/recommendations");
const store = require("../src/autopilot/store");
const engine = require("../src/autopilot/engine");

const SATURDAY = Date.parse("2026-11-07T15:00:00Z");
const WEDNESDAY_SESSION = Date.parse("2026-11-04T15:00:00Z"); // 10:00 New York
const WEDNESDAY_AFTER_CLOSE = Date.parse("2026-11-04T22:00:00Z"); // 17:00 New York
function withClock(at, fn) {
  const realNow = Date.now;
  Date.now = () => at;
  return Promise.resolve(fn()).finally(() => (Date.now = realNow));
}

function stubReview(counts) {
  const calls = { build: 0, gates: 0, prune: 0 };
  const savedLease = store.lease;
  store.lease = () => true; // the real 120s lease would block the repeated ticks this test needs
  const saved = { runDue: recommendations.runDue, build: feedback.buildDataset, gates: feedback.evaluateGates, prune: feedback.pruneHistory };
  recommendations.runDue = async () => ({ counts });
  feedback.buildDataset = () => ((calls.build += 1), { datasetVersion: "v" });
  feedback.evaluateGates = () => (calls.gates += 1);
  feedback.pruneHistory = () => (calls.prune += 1);
  return { calls, restore: () => (store.lease = savedLease) && Object.assign(recommendations, { runDue: saved.runDue }) && Object.assign(feedback, { buildDataset: saved.build, evaluateGates: saved.gates, pruneHistory: saved.prune }) };
}

test("reviewTick rebuilds the feedback dataset at most once per interval, however many ticks fire", () => withClock(SATURDAY, async () => {
  const stub = stubReview({ complete: 0, retryable: 2, failed: 1 });
  process.env.FEEDBACK_REBUILD_MIN_MS = "1800000";
  try {
    engine.resetFeedbackRebuildClock(0);
    for (let i = 0; i < 5; i++) {
      await engine.reviewTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(stub.calls, { build: 1, gates: 1, prune: 1 });
    engine.resetFeedbackRebuildClock(SATURDAY - 1800001);
    await engine.reviewTick();
    assert.equal(stub.calls.build, 2);
  } finally {
    stub.restore();
    delete process.env.FEEDBACK_REBUILD_MIN_MS;
  }
}));

test("reviewTick does not rebuild when no review needed attention, and FEEDBACK_REBUILD_MIN_MS=0 restores the old behaviour", () => withClock(SATURDAY, async () => {
  const idle = stubReview({ complete: 0, retryable: 0, failed: 0 });
  try {
    engine.resetFeedbackRebuildClock(0);
    await engine.reviewTick();
    assert.equal(idle.calls.build, 0);
  } finally {
    idle.restore();
  }
  const busy = stubReview({ complete: 1, retryable: 0, failed: 0 });
  process.env.FEEDBACK_REBUILD_MIN_MS = "0";
  try {
    await engine.reviewTick();
    await engine.reviewTick();
    assert.equal(busy.calls.build, 2);
  } finally {
    busy.restore();
    delete process.env.FEEDBACK_REBUILD_MIN_MS;
  }
}));

test("the rebuild is deferred while the US session is open and runs after the close", async () => {
  assert.equal(engine.isRegularSessionNow(WEDNESDAY_SESSION), true);
  assert.equal(engine.isRegularSessionNow(WEDNESDAY_AFTER_CLOSE), false);
  assert.equal(engine.isRegularSessionNow(SATURDAY), false);
  const stub = stubReview({ complete: 1, retryable: 0, failed: 0 });
  try {
    engine.resetFeedbackRebuildClock(0);
    await withClock(WEDNESDAY_SESSION, () => engine.reviewTick());
    assert.equal(stub.calls.build, 0, "must not run during the session");
    await withClock(WEDNESDAY_AFTER_CLOSE, () => engine.reviewTick());
    assert.equal(stub.calls.build, 1, "runs once the session is over");
  } finally {
    stub.restore();
  }
});

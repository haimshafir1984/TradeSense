const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
let db;
function database() {
  if (!db) {
    const file =
      process.env.AUTOPILOT_DB_PATH ||
      path.resolve(__dirname, "../data/autopilot.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT, PRIMARY KEY(kind,id));",
    );
    const columns = db.prepare("PRAGMA table_info(records)").all().map((row) => row.name);
    if (!columns.includes("metadata")) db.exec("ALTER TABLE records ADD COLUMN metadata TEXT");
    db.exec("UPDATE records SET metadata=json_object('symbol',json_extract(body,'$.symbol'),'feed',json_extract(body,'$.feed'),'timeframe',json_extract(body,'$.timeframe'),'lastUsedAt',json_extract(body,'$.lastUsedAt'),'fetchedAt',json_extract(body,'$.fetchedAt'),'sessionDate',json_extract(body,'$.sessionDate')) WHERE kind='history' AND metadata IS NULL");
  }
  return db;
}
function get(kind, id) {
  const row = database()
    .prepare("SELECT body FROM records WHERE kind=? AND id=?")
    .get(kind, id);
  return row ? JSON.parse(row.body) : null;
}
function list(kind) {
  return database()
    .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((r) => JSON.parse(r.body));
}
function listIds(kind) {
  return database()
    .prepare("SELECT id FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((r) => r.id);
}
function listMetadata(kind) {
  return database()
    .prepare("SELECT id, metadata FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((row) => ({ id: row.id, ...(row.metadata ? JSON.parse(row.metadata) : {}) }));
}
function put(kind, id, body) {
  database()
    .prepare(
      "INSERT INTO records(kind,id,body,metadata) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, metadata=excluded.metadata",
    )
    .run(kind, id, JSON.stringify(body), kind === "history" ? JSON.stringify({ symbol: body.symbol || null, feed: body.feed || null, timeframe: body.timeframe || null, lastUsedAt: body.lastUsedAt || null, fetchedAt: body.fetchedAt || null, sessionDate: body.sessionDate || null }) : null);
  return body;
}
function remove(kind, id) {
  database().prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
}
function userKind(userId, kind) {
  if (!userId || typeof userId !== "string" || userId.length > 80)
    throw new Error("משתמש לא תקין");
  return `user:${userId}:${kind}`;
}
function getUser(userId, kind, id) {
  return get(userKind(userId, kind), id);
}
function listUser(userId, kind) {
  return list(userKind(userId, kind));
}
function putUser(userId, kind, id, body) {
  return put(userKind(userId, kind), id, body);
}
function removeUser(userId, kind, id) {
  return remove(userKind(userId, kind), id);
}
function transaction(fn) {
  database().exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database().exec("COMMIT");
    return result;
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}
function lease(name, durationMs, now = Date.now()) {
  return transaction(() => {
    if ((get("lease", name)?.until || 0) > now) return false;
    put("lease", name, { until: now + durationMs });
    return true;
  });
}
function close() {
  if (db) {
    db.close();
    db = null;
  }
}
module.exports = {
  get,
  list,
  listIds,
  listMetadata,
  put,
  remove,
  getUser,
  listUser,
  putUser,
  removeUser,
  transaction,
  lease,
  close,
};

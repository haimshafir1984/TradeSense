const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const store = require("./store");

const SCOPED_KINDS = [
  "signal",
  "trade",
  "event",
  "subscription",
  "outbox",
  "delivery",
];

function hash(userId, code) {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

function same(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeCode(code) {
  if (typeof code !== "string" || !code.trim())
    throw new Error("יש להזין קוד כניסה");
  if (code.length > 80) throw new Error("קוד הכניסה ארוך מדי");
  return code.trim();
}

function all() {
  return store.list("user");
}

function migrateFirstUser(userId) {
  if (all().length) return;
  const legacySettings = store.get("config", "settings");
  if (legacySettings) store.putUser(userId, "config", "settings", legacySettings);
  for (const kind of SCOPED_KINDS)
    for (const item of store.list(kind))
      if (item?.id) store.putUser(userId, kind, item.id, item);
}

function session(input = {}) {
  const code = normalizeCode(input.code);
  let userId =
    typeof input.userId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(input.userId)
      ? input.userId
      : randomUUID();
  let user = store.get("user", userId);
  if (!user) {
    migrateFirstUser(userId);
    user = {
      id: userId,
      codeHash: hash(userId, code),
      createdAt: new Date().toISOString(),
    };
  } else if (!same(user.codeHash, hash(userId, code))) {
    const error = new Error("קוד הכניסה לא תואם לפרופיל הזה");
    error.status = 401;
    throw error;
  }
  user.lastSeenAt = new Date().toISOString();
  store.put("user", userId, user);
  return { userId };
}

function requireUser(req, _res, next) {
  try {
    const userId = req.headers["x-tradesense-user"];
    const code = (req.headers.authorization || "").replace(/^Bearer /, "");
    const current = session({ userId, code });
    req.userId = current.userId;
    next();
  } catch (error) {
    error.status = error.status || 401;
    next(error);
  }
}

module.exports = { all, session, requireUser };

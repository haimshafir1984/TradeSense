const { randomUUID, timingSafeEqual } = require("node:crypto");
const store = require("../autopilot/store");

const KIND = "executionOrder";
const STATUSES = [
  "pending",
  "claimed",
  "submitted",
  "partially_filled",
  "filled",
  "rejected",
  "canceled",
  "expired",
  "unknown",
];

const TRANSITIONS = {
  pending: new Set(["claimed", "canceled", "expired"]),
  claimed: new Set(["submitted", "rejected", "canceled", "expired", "unknown"]),
  submitted: new Set(["partially_filled", "filled", "rejected", "canceled", "unknown"]),
  partially_filled: new Set(["filled", "rejected", "canceled", "unknown"]),
  unknown: new Set(["submitted", "partially_filled", "filled", "rejected", "canceled"]),
  filled: new Set(),
  rejected: new Set(),
  canceled: new Set(),
  expired: new Set(),
};

function fail(message, code = "invalid_order") {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  throw error;
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function normalize(input = {}) {
  if (typeof input.symbol !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(input.symbol))
    fail("סימול לא תקין");
  if (!["buy", "sell"].includes(input.side)) fail("כיוון הוראה לא תקין");
  if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity <= 0)
    fail("כמות ההוראה חייבת להיות חיובית");
  if (input.quantity > 100000000) fail("כמות ההוראה חורגת מהמגבלה");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 160))
    fail("מפתח מניעת כפילות לא תקין");
  const prices = {};
  for (const key of ["limitPrice", "stopLoss", "takeProfit"]) {
    if (input[key] == null) prices[key] = null;
    else {
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value <= 0) fail(`${key} לא תקין`);
      prices[key] = value;
    }
  }
  return {
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    idempotencyKey: input.idempotencyKey || null,
    brokerAccountId: input.brokerAccountId || null,
    ...prices,
    signalId: input.signalId || null,
    strategy: input.strategy || null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function listAll() {
  return store.list(KIND);
}

function listForUser(userId) {
  return listAll().filter((order) => order.userId === userId);
}

function get(id) {
  return store.get(KIND, id);
}

function create(input, userId, now = Date.now()) {
  if (!userId) fail("משתמש חסר", "unauthorized");
  const normalized = normalize(input);
  return store.transaction(() => {
    if (normalized.idempotencyKey) {
      const existing = listAll().find((order) => order.idempotencyKey === normalized.idempotencyKey && order.userId === userId);
      if (existing) return { order: existing, duplicate: true };
    }
    const createdAt = isoNow(now);
    const order = {
      id: randomUUID(),
      userId,
      ...normalized,
      status: "pending",
      error: null,
      brokerOrderId: null,
      filledQuantity: 0,
      averagePrice: null,
      createdAt,
      updatedAt: createdAt,
      claimedAt: null,
      submittedAt: null,
      completedAt: null,
      lastEventAt: createdAt,
    };
    store.put(KIND, order.id, order);
    return { order, duplicate: false };
  });
}

function transition(id, nextStatus, patch = {}, now = Date.now()) {
  if (!STATUSES.includes(nextStatus)) fail("סטטוס הוראה לא תקין");
  return store.transaction(() => {
    const current = get(id);
    if (!current) {
      const error = new Error("הוראה לא נמצאה");
      error.code = "not_found";
      error.status = 404;
      throw error;
    }
    if (current.status !== nextStatus && !TRANSITIONS[current.status]?.has(nextStatus)) fail(`מעבר אסור: ${current.status} -> ${nextStatus}`, "invalid_transition");
    if (patch.error != null && typeof patch.error !== "string") fail("הודעת שגיאה לא תקינה");
    const updatedAt = isoNow(now);
    const order = {
      ...current,
      status: nextStatus,
      updatedAt,
      lastEventAt: updatedAt,
      error: patch.error == null ? current.error : patch.error,
      brokerOrderId: patch.brokerOrderId == null ? current.brokerOrderId : String(patch.brokerOrderId),
      filledQuantity: patch.filledQuantity == null ? current.filledQuantity : Number(patch.filledQuantity),
      averagePrice: patch.averagePrice == null ? current.averagePrice : Number(patch.averagePrice),
    };
    if (!Number.isFinite(order.filledQuantity) || order.filledQuantity < 0 || order.filledQuantity > current.quantity)
      fail("כמות ביצוע לא תקינה");
    if (nextStatus === "partially_filled" && order.filledQuantity <= 0)
      fail("דיווח ביצוע חלקי חייב לכלול כמות חיובית");
    if (nextStatus === "filled" && order.filledQuantity !== current.quantity)
      fail("דיווח ביצוע מלא חייב להתאים לכמות ההוראה");
    if (nextStatus === "claimed") order.claimedAt = updatedAt;
    if (nextStatus === "submitted") order.submittedAt = updatedAt;
    if (["filled", "rejected", "canceled", "expired"].includes(nextStatus)) order.completedAt = updatedAt;
    store.put(KIND, id, order);
    return order;
  });
}

function canUseExecutorToken(token, expected = process.env.EXECUTION_AGENT_TOKEN) {
  if (!expected || typeof token !== "string") return false;
  const left = Buffer.from(token);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

module.exports = { KIND, STATUSES, TRANSITIONS, normalize, listAll, listForUser, get, create, transition, canUseExecutorToken };

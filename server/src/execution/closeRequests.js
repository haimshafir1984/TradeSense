const { randomUUID } = require("node:crypto");
const store = require("../autopilot/store");
const positions = require("./positions");
const autonomy = require("./autonomy");

// Position commands for the MT4 EA: close, partial close and stop modification.
// "user" commands come from a dashboard click (any position of the demo account, explicit confirm).
// "system" commands come from the exit manager and only ever target positions TradeSense manages.
// The server only records the intent; the EA (demo only) claims it, executes it and reports the real result.
// Commands are short-lived so a stale one is never executed after the EA reconnects.
const KIND = "executionCloseRequest";
const TTL_MS = 120_000;
const STATUSES = ["pending", "claimed", "closed", "rejected", "expired", "unknown"];
const TYPES = ["close", "partial_close", "modify_stop"];
const TRANSITIONS = {
  pending: new Set(["claimed", "rejected", "expired"]),
  claimed: new Set(["closed", "rejected", "unknown"]),
  unknown: new Set(["closed", "rejected"]),
  closed: new Set(),
  rejected: new Set(),
  expired: new Set(),
};

function fail(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function isoNow(now) {
  return new Date(now).toISOString();
}

function listAll() {
  return store.list(KIND);
}

function get(id) {
  return store.get(KIND, id);
}

function open(request) {
  return request.status === "pending" || request.status === "claimed" || request.status === "unknown";
}

// Marks requests that nobody claimed in time as expired, so they can never run later.
function sweep(now = Date.now()) {
  for (const request of listAll()) {
    if (request.status === "pending" && Date.parse(request.createdAt) + TTL_MS <= now)
      store.put(KIND, request.id, { ...request, status: "expired", updatedAt: isoNow(now), error: "פג תוקף הבקשה לפני שה־EA קיבל אותה" });
  }
}

function checkReady(ticket, now) {
  if (process.env.EXECUTION_QUEUE_ENABLED !== "true")
    fail("תור הביצוע כבוי בשרת הזה, ולכן אי אפשר לשלוח פקודה ל־MT4", "queue_disabled");
  if (!autonomy.agentConnected(now)) fail("MT4 אינו מחובר ומאומת כחשבון דמו", "mt4_not_ready");
  const ticketText = String(ticket ?? "");
  if (!/^[0-9]{1,24}$/.test(ticketText)) fail("מספר פוזיציה לא תקין", "invalid_ticket", 400);
  const snapshot = positions.current(now);
  if (!snapshot.fresh) fail("אין דיווח עדכני מ־MT4; לא ניתן לפעול כרגע", "positions_stale");
  if (snapshot.isDemo !== true) fail("החשבון אינו מזוהה כדמו", "not_demo");
  const expected = process.env.EXECUTION_BROKER_ACCOUNT_ID;
  if (expected && snapshot.accountId !== expected) fail("חשבון MT4 לא תואם להגדרת השרת", "account_mismatch");
  const position = snapshot.positions.find((p) => p.ticket === ticketText);
  if (!position) fail("הפוזיציה אינה פתוחה (או שכבר נסגרה)", "position_not_found", 404);
  return { ticketText, snapshot, position };
}

function build({ source, type, userId, snapshot, position, lots, stopLoss, dedupeKey, reason, now }) {
  const createdAt = isoNow(now);
  return {
    id: randomUUID(),
    source,
    type,
    userId: userId || null,
    accountId: snapshot.accountId,
    ticket: position.ticket,
    symbol: position.symbol,
    side: position.side,
    lots: lots ?? position.lots,
    stopLoss: stopLoss ?? null,
    dedupeKey: dedupeKey || null,
    reason: reason || null,
    status: "pending",
    error: null,
    closePrice: null,
    remainingTicket: null,
    createdAt,
    updatedAt: createdAt,
    claimedAt: null,
    completedAt: null,
  };
}

// User click: closes the whole position. Allowed for any open position of the demo account.
function create({ ticket, userId, now = Date.now() }) {
  if (!userId) fail("משתמש חסר", "unauthorized", 401);
  const { ticketText, snapshot, position } = checkReady(ticket, now);
  return store.transaction(() => {
    sweep(now);
    const existing = listAll().find((r) => r.ticket === ticketText && r.accountId === snapshot.accountId && open(r));
    if (existing) return { request: existing, duplicate: true };
    const request = build({ source: "user", type: "close", userId, snapshot, position, now });
    store.put(KIND, request.id, request);
    return { request, duplicate: false };
  });
}

// Exit manager: only positions TradeSense manages, one command in flight per position, and a
// dedupe key that is remembered in every final status so a failed command is never retried on its own.
function enqueue({ type, ticket, lots, stopLoss, dedupeKey, reason, now = Date.now() }) {
  if (!TYPES.includes(type)) fail("סוג פקודה לא תקין", "invalid_type", 400);
  if (!dedupeKey) fail("חסר מפתח מניעת כפילות", "dedupe_required", 400);
  const { ticketText, snapshot, position } = checkReady(ticket, now);
  if (!position.managed) fail("הפוזיציה אינה מנוהלת על ידי TradeSense; הפעולה האוטומטית נחסמה", "not_managed");
  if (type === "partial_close" && !(Number(lots) > 0 && Number(lots) < position.lots)) fail("כמות סגירה חלקית לא תקינה", "invalid_lots", 400);
  if (type === "modify_stop" && !(Number(stopLoss) > 0)) fail("מחיר סטופ לא תקין", "invalid_stop", 400);
  return store.transaction(() => {
    sweep(now);
    const all = listAll();
    const same = all.find((r) => r.dedupeKey === dedupeKey);
    if (same) return { request: same, duplicate: true };
    const inFlight = all.find((r) => r.ticket === ticketText && r.accountId === snapshot.accountId && open(r));
    if (inFlight) return { request: inFlight, duplicate: true, blocked: "in_flight" };
    const request = build({ source: "system", type, snapshot, position, lots: type === "close" ? position.lots : Number(lots), stopLoss: type === "modify_stop" ? Number(stopLoss) : null, dedupeKey, reason, now });
    store.put(KIND, request.id, request);
    return { request, duplicate: false };
  });
}

function pendingForAccount(accountId, now = Date.now()) {
  sweep(now);
  return listAll().filter((r) => r.accountId === accountId && r.status === "pending");
}

function listForUser(userId, limit = 20) {
  return listAll()
    .filter((r) => r.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function transition(id, nextStatus, patch = {}, now = Date.now()) {
  if (!STATUSES.includes(nextStatus)) fail("סטטוס לא תקין", "invalid_status", 400);
  return store.transaction(() => {
    const current = get(id);
    if (!current) fail("בקשת הסגירה לא נמצאה", "not_found", 404);
    if (current.status !== nextStatus && !TRANSITIONS[current.status]?.has(nextStatus))
      fail(`מעבר אסור: ${current.status} -> ${nextStatus}`, "invalid_transition", 400);
    if (patch.error != null && typeof patch.error !== "string") fail("הודעת שגיאה לא תקינה", "invalid_error", 400);
    const closePrice = patch.closePrice == null ? current.closePrice : Number(patch.closePrice);
    if (closePrice != null && !Number.isFinite(closePrice)) fail("מחיר סגירה לא תקין", "invalid_price", 400);
    const remainingTicket = patch.remainingTicket == null ? current.remainingTicket : String(patch.remainingTicket);
    if (remainingTicket != null && !/^[0-9]{1,24}$/.test(remainingTicket)) fail("מספר פוזיציה שנותרה לא תקין", "invalid_ticket", 400);
    const request = {
      ...current,
      status: nextStatus,
      updatedAt: isoNow(now),
      error: patch.error == null ? current.error : patch.error.slice(0, 200),
      closePrice,
      remainingTicket,
    };
    if (nextStatus === "claimed") request.claimedAt = isoNow(now);
    if (["closed", "rejected", "expired"].includes(nextStatus)) request.completedAt = isoNow(now);
    store.put(KIND, id, request);
    return request;
  });
}

module.exports = { KIND, TTL_MS, STATUSES, TYPES, create, enqueue, get, listAll, listForUser, pendingForAccount, sweep, transition };

const { createHash } = require("node:crypto");
const webpush = require("web-push");
const store = require("./store");
function keys() {
  let keys = store.get("secret", "vapid");
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    store.put("secret", "vapid", keys);
  }
  webpush.setVapidDetails(
    process.env.PUSH_CONTACT || "mailto:admin@example.com",
    keys.publicKey,
    keys.privateKey,
  );
  return keys;
}
function subscribe(userId, subscription) {
  let url;
  try {
    url = new URL(subscription?.endpoint);
  } catch {
    throw new Error("כתובת התראות לא תקינה");
  }
  const allowed = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !allowed.some(
      (h) => url.hostname === h || url.hostname.endsWith("." + h),
    ) ||
    !subscription.keys?.p256dh ||
    !subscription.keys?.auth
  )
    throw new Error("שירות התראות לא נתמך");
  if (
    store.listUser(userId, "subscription").length >= 10 &&
    !store.getUser(
      userId,
      "subscription",
      createHash("sha256").update(url.href).digest("hex"),
    )
  )
    throw new Error("הגעת למגבלת המכשירים");
  const id = createHash("sha256").update(url.href).digest("hex");
  store.putUser(userId, "subscription", id, {
    id,
    endpoint: url.href,
    keys: subscription.keys,
  });
}
function event(userId, id, title, body, type = "info") {
  if (store.getUser(userId, "event", id)) return;
  store.putUser(userId, "event", id, {
    id,
    title,
    body,
    type,
    createdAt: new Date().toISOString(),
  });
  store.putUser(userId, "outbox", id, {
    id,
    title,
    body,
    createdAt: Date.now(),
    attempts: 0,
    nextAt: 0,
  });
}
async function flush(userIds) {
  keys();
  const users = userIds || store.list("user").map((u) => u.id);
  for (const userId of users) {
    for (const item of store.listUser(userId, "outbox").slice(0, 30)) {
      if (item.nextAt > Date.now()) continue;
      if (Date.now() - item.createdAt > 900000) {
        store.removeUser(userId, "outbox", item.id);
        continue;
      }
      let retry = false;
      for (const sub of store.listUser(userId, "subscription")) {
        if (store.getUser(userId, "delivery", `${item.id}:${sub.id}`))
          continue;
        try {
          await webpush.sendNotification(
            sub,
            JSON.stringify({ id: item.id, title: item.title, body: item.body }),
            { TTL: 300, timeout: 10000 },
          );
          store.putUser(userId, "delivery", `${item.id}:${sub.id}`, {
            at: Date.now(),
          });
        } catch (error) {
          if ([404, 410].includes(error.statusCode))
            store.removeUser(userId, "subscription", sub.id);
          else retry = true;
        }
      }
      if (retry && item.attempts < 4)
        store.putUser(userId, "outbox", item.id, {
          ...item,
          attempts: item.attempts + 1,
          nextAt: Date.now() + 60000,
        });
      else store.removeUser(userId, "outbox", item.id);
    }
  }
}
module.exports = { keys, subscribe, event, flush };

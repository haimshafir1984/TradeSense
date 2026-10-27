const exitLog = require("./exitLog");
const entryDecision = require("./entryDecision");

// One chronological feed of entry and exit decisions for the dashboard.
function feed(userId, limit = 100) {
  const entries = entryDecision.recentDecisions(userId, 300).map((e) => ({ ...e, kind: "entry" }));
  return [...entries, ...exitLog.list()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(1, Math.min(300, Number(limit) || 100)));
}

module.exports = { feed };

const store = require("../autopilot/store");
const orders = require("./orders");

// Outcome ledger: links each closed MT4 deal (by ticket) to the order the EA filled with that ticket
// and to the entry decision that produced the order, so results can be grouped by strategy and score.
const KIND = "executionOutcome";
const LOG = "entryDecision"; // the kind entryDecision.js writes (must stay in sync)
const round2 = (v) => Math.round(v * 100) / 100;

function findDecision(order) {
  try {
    return store.listUser(order.userId, LOG).find((e) => e.orderId === order.id) || null;
  } catch {
    return null;
  }
}

function record(deals, now = Date.now()) {
  if (!Array.isArray(deals)) return 0;
  const byTicket = new Map();
  for (const d of deals) if (d.ticket && !store.get(KIND, d.ticket)) byTicket.set(d.ticket, d);
  if (!byTicket.size) return 0;
  const all = orders.listAll();
  let saved = 0;
  for (const [ticket, d] of byTicket) {
    const order = all.find((o) => String(o.brokerOrderId) === ticket);
    if (!order) continue; // manual trade or another system: not ours to attribute
    const decision = findDecision(order);
    store.put(KIND, ticket, {
      ticket,
      userId: order.userId,
      orderId: order.id,
      symbol: order.symbol,
      side: d.side || order.side,
      lots: d.lots ?? null,
      openPrice: d.openPrice ?? null,
      closePrice: d.closePrice ?? null,
      openAt: d.openT ? new Date(d.openT * 1000).toISOString() : null,
      closedAt: new Date(d.t * 1000).toISOString(),
      profit: round2(d.p),
      strategies: decision?.strategies || (order.strategy ? [order.strategy] : []),
      score: decision?.score ?? null,
      families: decision?.families ?? [],
      recordedAt: new Date(now).toISOString(),
    });
    saved++;
    try {
      require("./exitLog").record({ outcome: "closed", symbol: String(order.symbol).replace(/#$/, ""), profit: round2(d.p), reasonText: `העסקה נסגרה ב־MT4 (סטופ, יעד או סגירה ידנית): ${round2(d.p) >= 0 ? "רווח" : "הפסד"} ${Math.abs(round2(d.p))}` }, d.t * 1000);
    } catch {}
  }
  return saved;
}

function stats(rows) {
  const wins = rows.filter((r) => r.profit > 0);
  const losses = rows.filter((r) => r.profit < 0);
  const sum = (a) => round2(a.reduce((s, r) => s + r.profit, 0));
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? round2((wins.length / rows.length) * 100) : null,
    total: sum(rows),
    avgWin: wins.length ? round2(sum(wins) / wins.length) : null,
    avgLoss: losses.length ? round2(sum(losses) / losses.length) : null,
  };
}

function summary(userId) {
  const rows = store.list(KIND).filter((r) => r.userId === userId);
  const group = (keys) => {
    const map = new Map();
    for (const r of rows) for (const k of keys(r)) map.set(k, [...(map.get(k) || []), r]);
    return Object.fromEntries([...map].map(([k, v]) => [k, stats(v)]));
  };
  const bucket = (r) => (r.score == null ? ["unknown"] : [`${Math.floor(r.score / 10) * 10}-${Math.floor(r.score / 10) * 10 + 9}`]);
  return {
    overall: stats(rows),
    byStrategy: group((r) => (r.strategies.length ? r.strategies : ["unknown"])),
    byScore: group(bucket),
    recent: rows.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)).slice(0, 50),
  };
}

module.exports = { KIND, record, summary, findDecision };

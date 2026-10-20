// Measurement only: records what the free (IEX) data shows before the open, so we can judge
// whether it is good enough for a pre-market strategy. It never creates signals or orders.
const store = require("./store");
const { nyDate } = require("./market");

const KIND = "premarketLog";
const SAMPLE_EVERY_MS = 5 * 60000;
const KEEP_DAYS = 14;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function compact(symbol, snap) {
  const last = num(snap?.latestTrade?.p);
  const prev = num(snap?.prevDailyBar?.c);
  return {
    s: symbol,
    last,
    lastAt: snap?.latestTrade?.t || null,
    bid: num(snap?.latestQuote?.bp),
    ask: num(snap?.latestQuote?.ap),
    prevClose: prev,
    gapPct: last != null && prev ? Math.round(((last - prev) / prev) * 10000) / 100 : null,
    minuteVol: num(snap?.minuteBar?.v),
    dailyVol: num(snap?.dailyBar?.v),
  };
}

// Pure: builds one sample from a snapshot map.
function sample(snapshots, symbols, now) {
  const rows = symbols.map((s) => compact(s, snapshots.get(s)));
  return {
    id: `${nyDate(now)}:${new Date(now).toISOString().slice(11, 16)}`,
    at: new Date(now).toISOString(),
    requested: symbols.length,
    withTrade: rows.filter((r) => r.last != null).length,
    rows,
  };
}

function save(doc) {
  store.put("runtime", `${KIND}:${doc.id}`, doc);
  const index = store.get("runtime", `${KIND}:index`) || { ids: [] };
  if (!index.ids.includes(doc.id)) index.ids.push(doc.id);
  const keep = index.ids.slice(-KEEP_DAYS * 24);
  for (const old of index.ids.slice(0, index.ids.length - keep.length)) store.remove("runtime", `${KIND}:${old}`);
  store.put("runtime", `${KIND}:index`, { ids: keep });
  return doc;
}

// True once per 5 minutes inside the hour and a half before the open.
function due(now, today) {
  return Boolean(today) && now >= today.open - 90 * 60000 && now < today.open && store.lease("premarket-log", SAMPLE_EVERY_MS, now);
}

function list(date) {
  const index = store.get("runtime", `${KIND}:index`) || { ids: [] };
  return index.ids
    .filter((id) => !date || id.startsWith(`${date}:`))
    .map((id) => store.get("runtime", `${KIND}:${id}`))
    .filter(Boolean);
}

module.exports = { sample, save, due, list };

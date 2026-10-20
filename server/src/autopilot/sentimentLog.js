// Measurement only: records the crowd sentiment on StockTwits (last ~30 public messages) for stocks the bot
// looks at, so it can later be compared with trade outcomes. It never creates signals, scores or orders.
// Free unauthenticated limit is about 200 requests per hour, so a local budget keeps well under it.
const store = require("./store");
const { nyDate } = require("./market");

const URL_BASE = "https://api.stocktwits.com/api/2/streams/symbol";
const HOURLY_BUDGET = 150;
const MAX_PER_SYMBOL_DAY = 40;
const SAMPLE_EVERY_MS = 20 * 60000;
const KEEP_DAYS = 14;
const spent = []; // timestamps of recent requests

function budgetLeft(now) {
  while (spent.length && spent[0] < now - 3600000) spent.shift();
  return spent.length < HOURLY_BUDGET;
}

// Pure: turns a StockTwits stream response into one compact sample.
function summarize(symbol, body, now) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let bullish = 0;
  let bearish = 0;
  for (const m of msgs) {
    const basic = m?.entities?.sentiment?.basic;
    if (basic === "Bullish") bullish++;
    else if (basic === "Bearish") bearish++;
  }
  const times = msgs.map((m) => Date.parse(m?.created_at)).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
  const tagged = bullish + bearish;
  return {
    s: symbol,
    at: new Date(now).toISOString(),
    messages: msgs.length,
    bullish,
    bearish,
    // -100 (all bearish) to 100 (all bullish) among tagged messages; null when nobody tagged a side.
    net: tagged ? Math.round(((bullish - bearish) / tagged) * 100) : null,
    spanMin: newest && oldest ? Math.round((newest - oldest) / 60000) : null,
    ageMin: newest ? Math.round((now - newest) / 60000) : null,
  };
}

async function fetchSample(symbol, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!budgetLeft(now)) return { s: symbol, at: new Date(now).toISOString(), error: "budget" };
  spent.push(now);
  try {
    const res = await fetchImpl(`${URL_BASE}/${encodeURIComponent(symbol)}.json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { s: symbol, at: new Date(now).toISOString(), error: `http_${res.status}` };
    return summarize(symbol, await res.json(), now);
  } catch (e) {
    return { s: symbol, at: new Date(now).toISOString(), error: String(e.message || e).slice(0, 80) };
  }
}

function save(sample, now = Date.now()) {
  const date = nyDate(now);
  const key = `sentiment:${date}`;
  const doc = store.get("runtime", key) || { date, symbols: {} };
  const list = doc.symbols[sample.s] || [];
  list.push(sample);
  doc.symbols[sample.s] = list.slice(-MAX_PER_SYMBOL_DAY);
  store.put("runtime", key, doc);
  const index = store.get("runtime", "sentiment:index") || { dates: [] };
  if (!index.dates.includes(date)) index.dates.push(date);
  const keep = index.dates.slice(-KEEP_DAYS);
  for (const old of index.dates.slice(0, index.dates.length - keep.length)) store.remove("runtime", `sentiment:${old}`);
  store.put("runtime", "sentiment:index", { dates: keep });
  return sample;
}

async function collect(symbol, opts = {}) {
  return save(await fetchSample(symbol, opts), opts.now);
}

// True once per 20 minutes while the market is open (used for the periodic sweep).
function due(now) {
  return store.lease("sentiment-log", SAMPLE_EVERY_MS, now);
}

async function sweep(symbols, opts = {}) {
  for (const s of symbols) {
    if (!budgetLeft(opts.now || Date.now())) break;
    await collect(s, opts);
  }
}

function read(date) {
  return store.get("runtime", `sentiment:${date}`) || { date, symbols: {} };
}

module.exports = { summarize, fetchSample, collect, sweep, due, read, _spent: spent };

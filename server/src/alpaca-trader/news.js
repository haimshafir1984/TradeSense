// Data collection only (no effect on trading): tags every shadow signal with whether a securities-offering / dilution headline
// appeared since the previous session's close. Purpose: the preregistered test HC (research/ideas, docs/RESEARCH_IDEAS_RESULTS_2026-11-14.md)
// had only 8 such events and needs 30, so the shadow sample accumulates them going forward.
// Fire-and-forget: a slow or failing news call never delays or breaks a scan. Off with ALPACA_TRADER_NEWS=off.
const { nyDate, nyTimestamp } = require("../autopilot/market");

// The exact keyword list frozen in research/ideas/protocol.json (HC.offeringKeywords): not tuned. Known false positives exist
// (for example "off-the-shelf"); the matched headline is stored so they can be reviewed by eye.
const OFFERING_KEYWORDS = ["offering", "public offering", "registered direct", "at-the-market", "at the market", "atm program", "shelf", "dilut", "private placement", "convertible", "priced"];
const MAX_PARALLEL = 2;

const isOffering = (headline) => {
  const text = String(headline || "").toLowerCase();
  return OFFERING_KEYWORDS.some((k) => text.includes(k));
};

// 16:00 New York of the previous weekday (holidays are not special-cased: a slightly longer window is harmless here).
function windowStart(now) {
  let t = now - 86400000;
  for (let i = 0; i < 4; i += 1) {
    const day = new Date(`${nyDate(t)}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) break;
    t -= 86400000;
  }
  return nyTimestamp(nyDate(t), "16:00");
}

async function fetchHeadlines(symbol, now, fetchImpl = fetch) {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return null;
  const params = new URLSearchParams({ symbols: symbol, start: new Date(windowStart(now)).toISOString(), end: new Date(now).toISOString(), limit: "50", sort: "asc" });
  const response = await fetchImpl(`https://data.alpaca.markets/v1beta1/news?${params}`, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
  if (!response.ok) throw new Error(`news HTTP ${response.status}`);
  const body = await response.json();
  return (body.news || []).map((item) => item.headline);
}

async function classify(symbol, now, fetchImpl) {
  const headlines = await fetchHeadlines(symbol, now, fetchImpl);
  if (!headlines) return null;
  const hit = headlines.find(isOffering) || null;
  return { newsCount: headlines.length, newsOffering: Boolean(hit), newsHeadline: hit ? String(hit).slice(0, 140) : null };
}

const done = new Map(); // `${date}|${symbol}` -> Promise<result|null>, one call per stock and day
let running = 0;
const waiting = [];
function slot() {
  return new Promise((resolve) => {
    const go = () => { running += 1; resolve(); };
    if (running < MAX_PARALLEL) go(); else waiting.push(go);
  });
}
function release() {
  running -= 1;
  waiting.shift()?.();
}

// onResult(result) is called once, only on success. Never throws.
function tag({ symbol, now = Date.now(), onResult, fetchImpl }) {
  if (process.env.ALPACA_TRADER_NEWS === "off") return Promise.resolve();
  const key = `${nyDate(now)}|${symbol}`;
  if (!done.has(key)) {
    done.set(key, (async () => {
      await slot();
      try {
        return await classify(symbol, now, fetchImpl);
      } catch {
        done.delete(key); // try again on the next signal of the day
        return null;
      } finally {
        release();
      }
    })());
  }
  return done.get(key).then((result) => { if (result) onResult(result); }).catch(() => {});
}

function reset() { done.clear(); running = 0; waiting.length = 0; }

module.exports = { tag, isOffering, classify, windowStart, reset, OFFERING_KEYWORDS };

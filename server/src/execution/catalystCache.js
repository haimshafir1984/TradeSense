// Catalyst lookups (earnings surprise, scheduled earnings, news spike, premarket gap) for the entry score.
// Fetched in the background when a symbol's decision box opens and read synchronously at decision time,
// so a slow or failing provider can never delay or block an entry: no data simply means no adjustment.
const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // symbol -> { at, catalyst }
const inflight = new Map();

function get(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  return hit && now - hit.at < TTL_MS ? hit.catalyst : null;
}

function prefetch(symbol, now = Date.now()) {
  if (get(symbol, now) || inflight.has(symbol)) return inflight.get(symbol) || Promise.resolve();
  const job = (async () => {
    try {
      const service = require("../pipeline/catalystService");
      const result = await service.detectCatalysts([symbol]);
      const catalyst = result.get(symbol);
      if (catalyst) cache.set(symbol, { at: Date.now(), catalyst });
    } catch {
      // Provider unavailable: leave the score unadjusted.
    } finally {
      inflight.delete(symbol);
    }
  })();
  inflight.set(symbol, job);
  return job;
}

// Points for a long entry, from the catalyst the pipeline identified. Positive earnings surprises and news
// activity help; a pending earnings report (event risk) and an unexplained gap hurt.
function points(catalyst, max = 8) {
  if (!catalyst || !catalyst.kind) return { pts: 0, note: null };
  let pts = 0;
  let note = null;
  const s = Number(catalyst.earningsSurprisePct);
  if (catalyst.kind === "earnings_surprise" && Number.isFinite(s)) {
    pts = s >= 10 ? 6 : s >= 3 ? 3 : s <= -3 ? -6 : 0;
    note = `דוח רווחים לאחרונה (הפתעה ${s.toFixed(1)}%)`;
  } else if (catalyst.kind === "earnings_scheduled") {
    pts = -4;
    note = "דוח רווחים צפוי בימים הקרובים";
  } else if (catalyst.kind === "news_spike") {
    pts = 3;
    note = "עלייה בכמות חדשות";
  } else if (catalyst.kind === "gap_no_news") {
    pts = -3;
    note = "גאפ ללא סיבה ידועה";
  }
  pts = Math.max(-max, Math.min(max, pts));
  return { pts, note: pts ? `${note} (${pts > 0 ? "+" : ""}${pts})` : null };
}

module.exports = { get, prefetch, points, TTL_MS, _clear: () => cache.clear() };

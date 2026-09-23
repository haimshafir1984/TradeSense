const alpaca = require("../providers/alpacaService");
const store = require("./store");
const NY_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const NY_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});
function nyDate(time = Date.now()) {
  return NY_DATE_FORMATTER.format(new Date(time));
}
function nyTimestamp(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const parts = NY_TIME_FORMATTER.formatToParts(new Date(guess));
  const actual =
    Number(parts.find((p) => p.type === "hour").value) * 60 +
    Number(parts.find((p) => p.type === "minute").value);
  const [h, m] = hhmm.split(":").map(Number);
  return guess + ((h * 60 + m - actual + 1440) % 1440) * 60000;
}
async function sessions(now = Date.now()) {
  const today = nyDate(now);
  let cached = store.get("cache", "calendar");
  if (!cached || cached.date !== today) {
    const start = nyDate(now - 40 * 86400000),
      end = nyDate(now + 20 * 86400000);
    const rows = await alpaca.getCalendar(start, end);
    if (!Array.isArray(rows) || !rows.length)
      throw new Error("לוח המסחר אינו זמין; איתותים חדשים הושהו");
    cached = { date: today, rows };
    store.put("cache", "calendar", cached);
  }
  return cached.rows.map((s) => ({
    date: s.date,
    open: nyTimestamp(s.date, s.open.slice(0, 5)),
    close: nyTimestamp(s.date, s.close.slice(0, 5)),
  }));
}
function normalizeSessions(rows) {
  return (rows || []).map((s) => ({
    date: s.date,
    open: nyTimestamp(s.date, s.open.slice(0, 5)),
    close: nyTimestamp(s.date, s.close.slice(0, 5)),
  })).sort((left, right) => left.open - right.open);
}
async function sessionsRange(startTime, endTime = startTime) {
  const startMs = Number.isFinite(startTime) ? startTime : Date.parse(startTime);
  const endMs = Number.isFinite(endTime) ? endTime : Date.parse(endTime);
  const start = nyDate(startMs - 10 * 86400000);
  const end = nyDate(endMs + 14 * 86400000);
  const cacheKey = `calendar:${start}:${end}`;
  let cached = store.get("cache", cacheKey);
  if (!cached) {
    const rows = await alpaca.getCalendar(start, end);
    if (!Array.isArray(rows) || !rows.length) throw new Error("calendar_unavailable");
    cached = { start, end, rows, fetchedAt: new Date().toISOString() };
    store.put("cache", cacheKey, cached);
  }
  return normalizeSessions(cached.rows);
}
function cachedSessionsRange(startTime, endTime = startTime) {
  const startMs = Number.isFinite(startTime) ? startTime : Date.parse(startTime);
  const endMs = Number.isFinite(endTime) ? endTime : Date.parse(endTime);
  const cached = store.get("cache", "calendar");
  const rows = normalizeSessions(cached?.rows || []);
  if (!rows.length) return [];
  return rows.filter((session) => session.close >= startMs - 86400000 && session.open <= endMs + 14 * 86400000);
}
function anchorSessionForPublished(sessionsList, publishedAt) {
  const published = Number.isFinite(publishedAt) ? publishedAt : Date.parse(publishedAt);
  const sessionsSorted = [...(sessionsList || [])].sort((left, right) => left.open - right.open);
  for (const session of sessionsSorted) {
    if (published <= session.close) {
      return {
        session,
        anchorRule: published < session.open ? "next_session_before_open" : "same_session_until_close",
      };
    }
  }
  return { session: null, anchorRule: "calendar_unavailable" };
}
function horizonSession(sessionsList, publishedAt, horizon) {
  const offsets = { d0: 0, d1: 1, d3: 3, d5: 5 };
  if (!(horizon in offsets)) return null;
  const { session, anchorRule } = anchorSessionForPublished(sessionsList, publishedAt);
  if (!session) return null;
  const sessionsSorted = [...sessionsList].sort((left, right) => left.open - right.open);
  const index = sessionsSorted.findIndex((item) => item.date === session.date);
  const target = sessionsSorted[index + offsets[horizon]];
  return target ? { session: target, anchorSession: session, anchorRule } : null;
}
function freshPrice(snapshot, now, ageMs = 90000) {
  const trade = snapshot?.latestTrade;
  const time = Date.parse(trade?.t),
    price = Number(trade?.p);
  return price > 0 &&
    Number.isFinite(time) &&
    time <= now + 1000 &&
    now - time <= ageMs
    ? { price, time, at: new Date(time).toISOString() }
    : null;
}
function delayedSipCutoff(wallNow) {
  const fiveMinutes = 300000;
  return Math.floor((wallNow - 16 * 60000) / fiveMinutes) * fiveMinutes;
}
function acceptDelayedSipBar(bar, cutoff) {
  const start = Date.parse(bar?.t);
  return Number.isFinite(start) && start + 300000 <= cutoff;
}
function delayedSipOpeningRvol(bars, calendar, today, wallNow, cutoff = delayedSipCutoff(wallNow)) {
  const session = calendar.find((item) => item.date === today.date);
  if (!session || cutoff < session.open + 15 * 60000 || cutoff > session.close) return null;
  const elapsed = Math.floor((cutoff - session.open) / 300000) * 300000;
  if (elapsed < 900000) return null;
  const safeBars = (bars || []).filter((bar) => acceptDelayedSipBar(bar, cutoff));
  function volume(s) {
    if (s.close - s.open < elapsed) return null;
    const sample = safeBars.filter((bar) => Date.parse(bar.t) >= s.open && Date.parse(bar.t) + 300000 <= s.open + elapsed);
    if (sample.length !== elapsed / 300000 || sample.some((bar, index) => Date.parse(bar.t) !== s.open + index * 300000 || !(bar.v > 0))) return null;
    return sample.reduce((sum, bar) => sum + bar.v, 0);
  }
  const current = volume(session);
  const prior = calendar.filter((item) => item.open < session.open).slice(-14);
  const history = prior.map(volume).filter((value) => value > 0);
  return current > 0 && history.length >= 5 ? current / (history.reduce((a, b) => a + b, 0) / history.length) : null;
}
function openingRvol(bars, calendar, today, now) {
  const elapsed =
    Math.floor(Math.min(now - today.open, today.close - today.open) / 300000) *
    300000;
  if (elapsed < 900000) return null;
  function volume(s) {
    if (s.close - s.open < elapsed) return null;
    const sample = bars.filter(
      (b) =>
        Date.parse(b.t) >= s.open &&
        Date.parse(b.t) + 300000 <= s.open + elapsed,
    );
    if (
      sample.length !== elapsed / 300000 ||
      sample.some(
        (b, i) => Date.parse(b.t) !== s.open + i * 300000 || !(b.v > 0),
      )
    )
      return null;
    return sample.reduce((sum, b) => sum + b.v, 0);
  }
  const current = volume(today);
  const history = calendar
    .filter((s) => s.open < today.open)
    .slice(-14)
    .map(volume)
    .filter((v) => v > 0);
  return current > 0 && history.length >= 5
    ? current / (history.reduce((a, b) => a + b, 0) / history.length)
    : null;
}
module.exports = { nyDate, nyTimestamp, sessions, sessionsRange, cachedSessionsRange, horizonSession, freshPrice, openingRvol, delayedSipCutoff, acceptDelayedSipBar, delayedSipOpeningRvol };

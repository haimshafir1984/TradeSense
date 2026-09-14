// v3 adaptations, fixed before evaluation. No inherited v2 performance or trader endorsements.
const STRATEGIES = [
  {
    key: "orb15",
    label: "פריצת טווח פתיחה",
    mode: "day",
    risk: "balanced",
    description: "פריצה מאושרת של טווח 15 הדקות הראשונות, בנפח יחסי מוגבר.",
    source: "https://ssrn.com/abstract=4729284",
  },
  {
    key: "gap_pullback",
    label: "גאפ ותיקון ראשון",
    mode: "day",
    risk: "aggressive",
    description:
      "גאפ חיובי, חדשות ותיקון שמסתיים בחידוש העלייה. גרסה כמותית של First Pullback.",
    source: "https://www.warriortrading.com/mastering-the-gap-and-go-strategy/",
  },
  {
    key: "vwap_reclaim",
    label: "חזרה מעל VWAP",
    mode: "day",
    risk: "balanced",
    description:
      "המחיר חוזר מעל הממוצע המשוקלל בנפח של היום. החישוב מבוסס IEX בלבד.",
    source:
      "https://members.bearbulltraders.com/trading-the-vwap-breakout-structure-timing-and-execution/",
  },
  {
    key: "reversal5",
    label: "התאוששות קצרה",
    mode: "swing",
    risk: "balanced",
    description:
      "אישור התאוששות אחרי ירידה חדה, כשהמגמה הארוכה עדיין חיובית. עד 5 ימי מסחר.",
    source: "https://doi.org/10.1093/rfs/3.2.175",
  },
  {
    key: "pullback2_v1",
    label: "תיקון יומיים במגמה",
    mode: "swing",
    risk: "balanced",
    description: "שתי ירידות בתוך מגמה עולה ואישור התאוששות בנר סגור.",
    source: "custom hypothesis",
    enabledByDefault: false,
    origin: "custom_hypothesis",
  },
  {
    key: "breakout20_v1",
    label: "פריצת שיא 20 יום",
    mode: "swing",
    risk: "aggressive",
    description: "פריצה בנר סגור של שיא 20 סשנים במגמה עולה.",
    source: "custom hypothesis",
    enabledByDefault: false,
    origin: "custom_hypothesis",
  },
].map((s) => ({ ...s, version: s.key.endsWith("_v1") ? "1.0.0" : "3.1.0", evidence: "experimental" }));
function completed(bars, asOf, intervalMs = 300000) {
  return (bars || [])
    .filter(
      (b) =>
        Date.parse(b.t) + intervalMs <= asOf &&
        [b.o, b.h, b.l, b.c, b.v].every(
          (v) => typeof v === "number" && Number.isFinite(v),
        ) &&
        b.l > 0 &&
        b.v > 0,
    )
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}
function vwap(bars) {
  if (!bars.length || bars.some((b) => !Number.isFinite(b.vw))) return null;
  const vol = bars.reduce((s, b) => s + b.v, 0);
  return vol > 0 ? bars.reduce((s, b) => s + b.v * b.vw, 0) / vol : null;
}
function swingEligible(key, daily) {
  if (!(daily?.barCount >= 200 && daily.price >= 5 && daily.price > daily.ma200 &&
        daily.avgDollarVolume20d >= 20000000 && daily.atr14 > 0)) return false;
  if (key === "pullback2_v1") {
    const ret = (daily.price / daily.previousClose2 - 1) * 100;
    return daily.ma20 > daily.ma50 && daily.price < daily.previousClose1 &&
      daily.previousClose1 < daily.previousClose2 && ret >= -5 && ret <= -1 &&
      daily.price >= daily.ma20 - daily.atr14 &&
      daily.previousLow1 > 0 && daily.previousLow2 > 0;
  }
  return daily.ma20 > daily.ma50 && daily.ma50 > daily.ma200 &&
    Number.isFinite(daily.high20) && daily.high20 - daily.price <= daily.atr14;
}
function evaluate({
  daily,
  bars,
  asOf,
  sessionOpen,
  sessionClose,
  rvol,
  gapPct,
  hasNews,
}) {
  const candles = completed(bars, asOf).filter(
    (b) => Date.parse(b.t) >= sessionOpen && Date.parse(b.t) < sessionClose,
  );
  const last = candles.at(-1),
    prev = candles.at(-2);
  if (
    !last ||
    !prev ||
    !Number.isFinite(daily?.atr14) ||
    daily.atr14 <= 0 ||
    asOf - Date.parse(last.t) > 420000
  )
    return [];
  const minutes = (asOf - sessionOpen) / 60000;
  const matches = [];
  const range = candles.filter((b) => Date.parse(b.t) < sessionOpen + 900000);
  const rangeComplete =
    range.length === 3 &&
    range.every((b, i) => Date.parse(b.t) === sessionOpen + i * 300000);
  const high = rangeComplete ? Math.max(...range.map((b) => b.h)) : null;
  const low = rangeComplete ? Math.min(...range.map((b) => b.l)) : null;
  function add(key, stop, target, reason) {
    const distance = last.c - stop;
    if (
      !Number.isFinite(stop) ||
      !Number.isFinite(target) ||
      stop <= 0 ||
      distance <= 0 ||
      target <= last.c ||
      distance / last.c < 0.002 ||
      distance / last.c > 0.12
    )
      return;
    matches.push({
      strategy: key,
      entry: last.c,
      maxEntry: Math.min(last.c + distance * 0.15, target - distance),
      stop,
      target,
      reason,
      barAt: last.t,
    });
  }
  if (
    minutes >= 20 &&
    minutes <= 120 &&
    rangeComplete &&
    rvol >= 1.5 &&
    prev.c <= high &&
    last.c > high &&
    last.c > last.o
  ) {
    const stop = Math.max(low, last.c - 1.5 * daily.atr14);
    add(
      "orb15",
      stop,
      last.c + 2 * (last.c - stop),
      "פריצה מעל טווח הפתיחה בנפח יחסי מוגבר",
    );
  }
  if (
    minutes >= 20 &&
    minutes <= 120 &&
    gapPct >= 3 &&
    hasNews === true &&
    rvol >= 1.5 &&
    candles.length >= 4
  ) {
    const pull = candles.at(-2),
      before = candles.at(-3);
    if (
      pull.c < pull.o &&
      pull.l > candles[0].l &&
      before.c > before.o &&
      last.c > pull.h
    ) {
      const stop = Math.min(pull.l, last.l);
      add(
        "gap_pullback",
        stop,
        last.c + 2 * (last.c - stop),
        "גאפ עם חדשות, תיקון וחידוש עלייה",
      );
    }
  }
  const vw = vwap(candles),
    prevVw = vwap(candles.slice(0, -1));
  if (
    minutes >= 30 &&
    minutes <= 300 &&
    vw &&
    prevVw &&
    rvol >= 1.2 &&
    prev.c <= prevVw &&
    last.c > vw &&
    last.c > last.o
  ) {
    const stop = Math.min(prev.l, last.l);
    add(
      "vwap_reclaim",
      stop,
      last.c + 2 * (last.c - stop),
      "חזרה מעל VWAP של IEX עם אישור בנר סגור",
    );
  }
  if (
    minutes >= 20 &&
    minutes <= 330 &&
    daily.price > daily.ma200 &&
    daily.return5d <= -5 &&
    daily.rsi14 < 35 &&
    last.c > prev.h
  ) {
    const stop = last.c - 1.5 * daily.atr14;
    add(
      "reversal5",
      stop,
      Math.min(daily.ma20, last.c + 2 * (last.c - stop)),
      "ירידה של 5% לפחות ואישור התאוששות מעל מגמה ארוכה",
    );
  }
  const p1 = candles.at(-2);
  const dailyReturn2 = daily?.previousClose2 > 0
    ? ((daily.price / daily.previousClose2) - 1) * 100
    : null;
  if (
    swingEligible("pullback2_v1", daily) &&
    minutes >= 30 && asOf <= sessionClose - 3600000 &&
    Date.parse(last.t) - Date.parse(p1?.t) === 300000 &&
    daily?.ma20 > daily?.ma50 &&
    dailyReturn2 >= -5 && dailyReturn2 <= -1 &&
    daily?.price >= daily.ma20 - daily.atr14 &&
    p1 && last.c > p1.h && last.c > last.o
  ) {
    const stop = Math.min(daily.previousLow1 || last.l, daily.previousLow2 || last.l) - 0.1 * daily.atr14;
    const risk = last.c - stop;
    if (stop > 0 && risk / last.c >= 0.005 && risk / last.c <= 0.08)
      matches.push({ strategy: "pullback2_v1", entry: last.c, maxEntry: last.c + 0.15 * risk, stop, target: last.c + 2 * risk, reason: "תיקון יומיים ואישור התאוששות", barAt: last.t });
  }
  const high20 = daily?.high20;
  if (
    swingEligible("breakout20_v1", daily) &&
    minutes >= 30 && asOf <= sessionClose - 3600000 &&
    Date.parse(last.t) - Date.parse(p1?.t) === 300000 &&
    daily?.ma20 > daily?.ma50 && daily?.ma50 > daily?.ma200 &&
    Number.isFinite(high20) && high20 - daily.price <= daily.atr14 &&
    p1 && p1.c <= high20 && last.c > high20 && last.c > last.o
  ) {
    const stop = last.c - 1.5 * daily.atr14;
    const risk = last.c - stop;
    if (stop > 0 && risk / last.c >= 0.005 && risk / last.c <= 0.08)
      matches.push({ strategy: "breakout20_v1", entry: last.c, maxEntry: last.c + 0.15 * risk, stop, target: last.c + 2 * risk, reason: "פריצת שיא 20 יום", barAt: last.t });
  }
  return matches;
}
function evaluateDetailed(args) {
  const plans = evaluate(args);
  const byStrategy = new Map(plans.map((plan) => [plan.strategy, { matched: true, plan }]));
  const candles = completed(args.bars, args.asOf).filter(
    (bar) => Date.parse(bar.t) >= args.sessionOpen && Date.parse(bar.t) < args.sessionClose,
  );
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const minutes = (args.asOf - args.sessionOpen) / 60000;
  const range = candles.filter((bar) => Date.parse(bar.t) < args.sessionOpen + 900000);
  const rangeComplete =
    range.length === 3 &&
    range.every((bar, index) => Date.parse(bar.t) === args.sessionOpen + index * 300000);
  const high = rangeComplete ? Math.max(...range.map((bar) => bar.h)) : null;
  const vw = vwap(candles);
  const prevVw = vwap(candles.slice(0, -1));

  function setReason(strategy, reasonCode) {
    if (!byStrategy.has(strategy)) byStrategy.set(strategy, { matched: false, reasonCode });
  }

  if (!Number.isFinite(args.daily?.atr14) || args.daily.atr14 <= 0) {
    for (const strategy of STRATEGIES) setReason(strategy.key, "daily_missing");
    return { plans, results: byStrategy };
  }
  if (!last || !prev || args.asOf - Date.parse(last.t) > 420000) {
    for (const strategy of STRATEGIES) setReason(strategy.key, "intraday_missing");
    return { plans, results: byStrategy };
  }

  if (minutes < 20 || minutes > 120) setReason("orb15", "outside_window");
  else if (!rangeComplete) setReason("orb15", "opening_range_incomplete");
  else if (args.rvol == null) setReason("orb15", "rvol_missing");
  else if (args.rvol < 1.5) setReason("orb15", "rvol_below_threshold");
  else if (!(prev.c <= high && last.c > high && last.c > last.o)) setReason("orb15", "trigger_not_met");

  if (minutes < 20 || minutes > 120) setReason("gap_pullback", "outside_window");
  else if (!(args.gapPct >= 3)) setReason("gap_pullback", "daily_missing");
  else if (args.rvol == null) setReason("gap_pullback", "rvol_missing");
  else if (args.rvol < 1.5) setReason("gap_pullback", "rvol_below_threshold");
  else if (
    candles.length < 4 ||
    !(candles.at(-2).c < candles.at(-2).o) ||
    !(candles.at(-2).l > candles[0].l) ||
    !(candles.at(-3).c > candles.at(-3).o) ||
    !(last.c > candles.at(-2).h)
  )
    setReason("gap_pullback", "trigger_not_met");
  else if (args.hasNews == null) setReason("gap_pullback", "news_needed");
  else if (args.hasNews === "unavailable") setReason("gap_pullback", "news_unavailable");
  else if (args.hasNews === false) setReason("gap_pullback", "news_absent");

  if (minutes < 30 || minutes > 300) setReason("vwap_reclaim", "outside_window");
  else if (args.rvol == null) setReason("vwap_reclaim", "rvol_missing");
  else if (args.rvol < 1.2) setReason("vwap_reclaim", "rvol_below_threshold");
  else if (!vw || !prevVw) setReason("vwap_reclaim", "intraday_missing");
  else if (!(prev.c <= prevVw && last.c > vw && last.c > last.o)) setReason("vwap_reclaim", "trigger_not_met");

  if (minutes < 20 || minutes > 330) setReason("reversal5", "outside_window");
  else if (!(args.daily?.price > args.daily?.ma200)) setReason("reversal5", "daily_missing");
  else if (!(args.daily?.return5d <= -5 && args.daily?.rsi14 < 35)) setReason("reversal5", "daily_missing");
  else if (!(last.c > prev.h)) setReason("reversal5", "trigger_not_met");

  if (minutes < 30 || args.asOf > args.sessionClose - 3600000) setReason("pullback2_v1", "outside_window");
  else if (!(args.daily?.ma20 > args.daily?.ma50) || !Number.isFinite(args.daily?.previousClose2)) setReason("pullback2_v1", "daily_missing");
  else if (!(last.c > prev.h && last.c > last.o)) setReason("pullback2_v1", "trigger_not_met");

  if (minutes < 30 || args.asOf > args.sessionClose - 3600000) setReason("breakout20_v1", "outside_window");
  else if (!(args.daily?.ma20 > args.daily?.ma50 && args.daily?.ma50 > args.daily?.ma200) || !Number.isFinite(args.daily?.high20)) setReason("breakout20_v1", "daily_missing");
  else if (!(prev.c <= args.daily.high20 && last.c > args.daily.high20 && last.c > last.o)) setReason("breakout20_v1", "trigger_not_met");

  for (const strategy of STRATEGIES) {
    if (!byStrategy.has(strategy.key)) setReason(strategy.key, "invalid_plan");
  }
  return { plans, results: byStrategy };
}
module.exports = { STRATEGIES, evaluate, evaluateDetailed, completed, vwap, swingEligible };

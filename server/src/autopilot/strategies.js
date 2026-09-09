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
].map((s) => ({ ...s, version: "3.1.0", evidence: "experimental" }));
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

  for (const strategy of STRATEGIES) {
    if (!byStrategy.has(strategy.key)) setReason(strategy.key, "invalid_plan");
  }
  return { plans, results: byStrategy };
}
module.exports = { STRATEGIES, evaluate, evaluateDetailed, completed, vwap };

const store = require("./store");
const market = require("./market");
const { swingEligible } = require("./strategies");

const parsedCap = Number(process.env.AUTOPILOT_DEEP_SCAN_MAX || 120);
const MAX_SELECTED = Number.isFinite(parsedCap) ? Math.min(120, Math.max(1, Math.floor(parsedCap))) : 120;
const ROTATION_COUNT = Math.floor(MAX_SELECTED / 6);
const MAX_STRATEGY_SELECTED = MAX_SELECTED - ROTATION_COUNT;

const WATCH_REASONS = {
  trigger_not_met: "עברה את הסינון הראשוני, אבל טריגר הכניסה עדיין לא הופיע בנר סגור.",
  rvol_below_threshold: "המניה מעניינת, אבל הנפח היחסי עדיין נמוך מדי לפי IEX.",
};

function snapshotDate(snapshot) {
  const time = Date.parse(snapshot?.dailyBar?.t || 0);
  return Number.isFinite(time) ? market.nyDate(time) : null;
}

function dailyVolume(snapshot, todayDate) {
  return snapshotDate(snapshot) === todayDate
    ? Number(snapshot?.dailyBar?.v || 0) * Number(snapshot?.dailyBar?.c || 0)
    : 0;
}

function openingGapPct(snapshot, prevClose, todayDate) {
  const open = Number(snapshot?.dailyBar?.o);
  return snapshotDate(snapshot) === todayDate && open > 0 && prevClose > 0
    ? ((open - prevClose) / prevClose) * 100
    : null;
}

function changePct(price, prevClose) {
  return price?.price > 0 && prevClose > 0 ? ((price.price - prevClose) / prevClose) * 100 : null;
}

function comparableRvolScore(symbol, intradayCache, calendar, today, now) {
  const bars = intradayCache?.get?.(symbol) || [];
  return market.openingRvol(bars, calendar, today, now);
}

function pushSorted(lists, key, item) {
  if (!lists[key]) lists[key] = [];
  lists[key].push(item);
}

function buildLists({ rows, snapshots, dailyFeatures, intradayCache, rvolScores, activeStrategies, calendar, today, now }) {
  const lists = {};
  const strategySet = new Set(activeStrategies);
  const todayDate = today.date;
  const unavailable = [];

  for (const row of rows) {
    const unavailableAt = Date.parse(store.get("scanCooldown", row.symbol)?.until || 0);
    if (unavailableAt > now) continue;
    const snapshot = snapshots.get(row.symbol);
    const price = market.freshPrice(snapshot, now);
    const daily = dailyFeatures.get(row.symbol)?.features || dailyFeatures.get(row.symbol);
    if (!daily) continue;
    const hasDailySwing = strategySet.has("reversal5") && daily.price > daily.ma200 && daily.return5d <= -5 && daily.rsi14 < 35 ||
      strategySet.has("pullback2_v1") && swingEligible("pullback2_v1", daily) ||
      strategySet.has("breakout20_v1") && swingEligible("breakout20_v1", daily);
    const volume = dailyVolume(snapshot, todayDate);
    const chg = changePct(price, row.close || daily?.price);
    if ((!price || price.price < 5 || snapshotDate(snapshot) !== todayDate) &&
        !(process.env.AUTOPILOT_SCAN_PROFILE !== "legacy" && hasDailySwing)) {
      unavailable.push({ symbol: row.symbol, reasonCode: "live_price_stale" });
      continue;
    }

    if (strategySet.has("orb15") && chg > 0) {
      pushSorted(lists, "orb15", { ...row, price, snapshot, daily, score: chg, volume, candidateFor: "orb15" });
    }
    const gap = openingGapPct(snapshot, row.close || daily?.price, todayDate);
    if (strategySet.has("gap_pullback") && gap >= 3) {
      pushSorted(lists, "gap_pullback", {
        ...row,
        price,
        snapshot,
        daily,
        score: gap,
        volume,
        candidateFor: "gap_pullback",
      });
    }
    if (strategySet.has("vwap_reclaim") && volume > 0) {
      const rvolScore = rvolScores ? rvolScores.get(row.symbol) : comparableRvolScore(row.symbol, intradayCache, calendar, today, now);
      pushSorted(lists, "vwap_reclaim", {
        ...row,
        price,
        snapshot,
        daily,
        score: Number.isFinite(rvolScore) ? rvolScore : null,
        volume,
        candidateFor: "vwap_reclaim",
      });
    }
    if (
      strategySet.has("reversal5") &&
      daily?.price > daily?.ma200 &&
      daily?.return5d <= -5 &&
      daily?.rsi14 < 35
    ) {
      pushSorted(lists, "reversal5", {
        ...row,
        price,
        snapshot,
        daily,
        score: daily.rsi14,
        secondary: daily.return5d,
        volume,
        candidateFor: "reversal5",
      });
    }
    const return2 = daily?.previousClose2 > 0 ? ((daily.price / daily.previousClose2) - 1) * 100 : null;
    if (strategySet.has("pullback2_v1") && swingEligible("pullback2_v1", daily)) {
      pushSorted(lists, "pullback2_v1", { ...row, price, snapshot, daily, score: return2, volume, candidateFor: "pullback2_v1" });
    }
    if (strategySet.has("breakout20_v1") && swingEligible("breakout20_v1", daily)) {
      pushSorted(lists, "breakout20_v1", { ...row, price, snapshot, daily, score: (daily.high20 - daily.price) / daily.atr14, volume, candidateFor: "breakout20_v1" });
    }
  }

  for (const key of Object.keys(lists)) {
    lists[key].sort((left, right) => {
      if (key === "reversal5") {
        return left.score - right.score || left.secondary - right.secondary || left.symbol.localeCompare(right.symbol);
      }
      if (key === "vwap_reclaim") {
        const leftScore = left.score == null ? -Infinity : left.score;
        const rightScore = right.score == null ? -Infinity : right.score;
        return rightScore - leftScore || right.volume - left.volume || left.symbol.localeCompare(right.symbol);
      }
      if (key === "pullback2_v1" || key === "breakout20_v1") {
        return left.score - right.score || right.volume - left.volume || left.symbol.localeCompare(right.symbol);
      }
      return right.score - left.score || right.volume - left.volume || left.symbol.localeCompare(right.symbol);
    });
  }

  return { lists, unavailable };
}

function roundRobin(lists, limit = MAX_STRATEGY_SELECTED, lane = null, fairBuckets = true) {
  const allKeys = ["orb15", "gap_pullback", "vwap_reclaim", "reversal5", "pullback2_v1", "breakout20_v1"];
  const keys = allKeys.filter((key) => lists[key]?.length && (!lane || (["orb15", "gap_pullback", "vwap_reclaim"].includes(key) ? lane === "day" : lane === "swing")));
  if (!fairBuckets) {
    const indexes = Object.fromEntries(keys.map((key) => [key, 0]));
    const picked = [], seenSymbols = new Set();
    while (picked.length < limit) {
      let moved = false;
      for (const key of keys) {
        while (indexes[key] < lists[key].length && seenSymbols.has(lists[key][indexes[key]].symbol)) indexes[key] += 1;
        const item = lists[key][indexes[key]];
        if (!item) continue;
        indexes[key] += 1; picked.push({ ...item, selectedFor: key }); seenSymbols.add(item.symbol); moved = true;
        if (picked.length >= limit) break;
      }
      if (!moved) break;
    }
    return picked;
  }
  const selected = [];
  const seen = new Set();
  const bucketOrder = ["medium_liquidity", "high_liquidity", "lower_liquidity"];
  const grouped = Object.fromEntries(keys.map((key) => [key, Object.fromEntries(bucketOrder.map((bucket) => [bucket, lists[key].filter((item) => universeBucket(item) === bucket)]))]));
  const indexes = Object.fromEntries(keys.map((key) => [key, Object.fromEntries(bucketOrder.map((bucket) => [bucket, 0]))]));
  const turns = Object.fromEntries(keys.map((key) => [key, 0]));

  while (selected.length < limit) {
    let moved = false;
    for (const key of keys) {
      let item = null;
      for (let attempt = 0; attempt < bucketOrder.length; attempt += 1) {
        const bucket = bucketOrder[(turns[key] + attempt) % bucketOrder.length];
        const bucketRows = grouped[key][bucket];
        while (indexes[key][bucket] < bucketRows.length && seen.has(bucketRows[indexes[key][bucket]].symbol)) indexes[key][bucket] += 1;
        if (bucketRows[indexes[key][bucket]]) {
          item = bucketRows[indexes[key][bucket]++];
          turns[key] = (bucketOrder.indexOf(bucket) + 1) % bucketOrder.length;
          break;
        }
      }
      if (!item) continue;
      selected.push({ ...item, selectedFor: key });
      seen.add(item.symbol);
      moved = true;
      if (selected.length >= limit) break;
    }
    if (!moved) break;
  }
  return selected;
}

function universeBucket(row) {
  const adv = Number(row.avgDollarVolume20d) || 0;
  return adv < 20_000_000 ? "lower_liquidity" : adv < 100_000_000 ? "medium_liquidity" : "high_liquidity";
}

function rotation(rows, alreadySelected, count = ROTATION_COUNT) {
  const stable = [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!stable.length || count <= 0) return [];
  const cursorState = store.get("runtime", "selection-cursors")?.values || {};
  const buckets = Object.fromEntries(["medium_liquidity", "high_liquidity", "lower_liquidity"].map((key) => [key, stable.filter((row) => universeBucket(row) === key)]));
  const offsets = Object.fromEntries(Object.entries(buckets).map(([key, rowsInBucket]) => [key, rowsInBucket.length ? (Number(cursorState[key]) || 0) % rowsInBucket.length : 0]));
  const picks = [], seen = new Set(alreadySelected);
  while (picks.length < count) {
    let moved = false;
    for (const key of ["medium_liquidity", "high_liquidity", "lower_liquidity"]) {
      const list = buckets[key];
      for (let scanned = 0; scanned < list.length; scanned += 1) {
        const row = list[(offsets[key] + scanned) % list.length];
        if (seen.has(row.symbol)) continue;
        picks.push(row); seen.add(row.symbol); offsets[key] = (offsets[key] + scanned + 1) % list.length; moved = true; break;
      }
      if (picks.length >= count) break;
    }
    if (!moved) break;
  }
  return picks.map((row) => ({ ...row, selectedFor: "rotation" }));
}

function selectCandidates(input) {
  const { rows = [] } = input;
  const { lists, unavailable } = buildLists(input);
  const strategyLimit = MAX_SELECTED - ROTATION_COUNT;
  const dayTarget = Math.ceil(strategyLimit * 0.6);
  const swingTarget = strategyLimit - dayTarget;
  const dayPicked = roundRobin(lists, dayTarget, "day");
  const daySymbols = new Set(dayPicked.map((row) => row.symbol));
  const swingPicked = roundRobin(lists, swingTarget, "swing").filter((row) => !daySymbols.has(row.symbol));
  const strategySymbols = new Set([...dayPicked, ...swingPicked].map((row) => row.symbol));
  let strategyRemainder = strategyLimit - strategySymbols.size;
  const dayFallback = roundRobin(lists, strategyLimit, "day").filter((row) => !strategySymbols.has(row.symbol)).slice(0, strategyRemainder);
  dayFallback.forEach((row) => strategySymbols.add(row.symbol));
  strategyRemainder -= dayFallback.length;
  const swingFallback = roundRobin(lists, strategyLimit, "swing").filter((row) => !strategySymbols.has(row.symbol)).slice(0, strategyRemainder);
  const fromStrategies = [...dayPicked, ...swingPicked, ...dayFallback, ...swingFallback];
  const selectedSymbols = new Set(fromStrategies.map((item) => item.symbol));
  const rotated = rotation(rows, selectedSymbols, Math.max(0, MAX_SELECTED - fromStrategies.length));
  const selected = [...fromStrategies, ...rotated].slice(0, MAX_SELECTED);
  const memberships = new Map();
  for (const [strategy, list] of Object.entries(lists)) {
    for (const item of list) {
      if (!memberships.has(item.symbol)) memberships.set(item.symbol, new Set());
      memberships.get(item.symbol).add(strategy);
    }
  }
  for (const item of selected) {
    const eligible = new Set(memberships.get(item.symbol) || []);
    item.eligibleStrategies = [...eligible].filter((key) => input.activeStrategies.includes(key));
  }
  let finalSelected = selected;
  if (process.env.AUTOPILOT_SCAN_PROFILE === "legacy") {
    const legacyStrategyRows = roundRobin(lists, Math.min(100, MAX_SELECTED), null, false);
    finalSelected = [...legacyStrategyRows, ...rotation(rows, new Set(legacyStrategyRows.map((row) => row.symbol)), Math.max(0, MAX_SELECTED - legacyStrategyRows.length))].slice(0, MAX_SELECTED);
    for (const item of finalSelected) item.eligibleStrategies = [...(memberships.get(item.symbol) || [])].filter((key) => input.activeStrategies.includes(key));
  }
  return {
    selected: finalSelected,
    lists,
    unavailable,
    diagnostics: {
      selectedCount: selected.length,
      strategySelectedCount: fromStrategies.length,
      daySelectedCount: dayPicked.length,
      swingSelectedCount: swingPicked.length,
      rotationCount: rotated.length,
      listSizes: Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, list.length])),
    },
  };
}

function commitRotationProgress(rows, selected) {
  const cursor = store.get("runtime", "selection-cursors")?.values || {};
  const updates = { ...cursor };
  for (const key of ["medium_liquidity", "high_liquidity", "lower_liquidity"]) {
    const members = [...rows].filter((row) => universeBucket(row) === key).sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (!members.length) continue;
    const selectedSymbols = new Set(selected.filter((row) => row.selectedFor === "rotation" && universeBucket(row) === key).map((row) => row.symbol));
    if (!selectedSymbols.size) continue;
    let position = Number(cursor[key]) || 0;
    let picked = 0;
    for (let scanned = 0; scanned < members.length && picked < selectedSymbols.size; scanned += 1) {
      if (selectedSymbols.has(members[(position + scanned) % members.length].symbol)) {
        position = (position + scanned + 1) % members.length;
        scanned = -1;
        picked += 1;
      }
    }
    updates[key] = position;
  }
  store.put("runtime", "selection-cursors", { values: updates, updatedAt: new Date().toISOString() });
}

function reasonText(reasonCode) {
  return WATCH_REASONS[reasonCode] || "נבדקה בסריקה האחרונה, אבל אין עדיין איתות כניסה.";
}

module.exports = {
  selectCandidates,
  buildLists,
  reasonText,
  WATCH_REASONS,
  dailyVolume,
  openingGapPct,
  changePct,
  commitRotationProgress,
};

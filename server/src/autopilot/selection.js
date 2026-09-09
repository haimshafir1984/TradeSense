const store = require("./store");
const market = require("./market");

const MAX_SELECTED = Math.min(200, Math.max(1, Number(process.env.AUTOPILOT_DEEP_SCAN_MAX || 120) || 120));
const MAX_STRATEGY_SELECTED = 100;
const ROTATION_COUNT = 20;

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

function buildLists({ rows, snapshots, dailyFeatures, intradayCache, activeStrategies, calendar, today, now }) {
  const lists = {};
  const strategySet = new Set(activeStrategies);
  const todayDate = today.date;
  const unavailable = [];

  for (const row of rows) {
    const snapshot = snapshots.get(row.symbol);
    const price = market.freshPrice(snapshot, now);
    const daily = dailyFeatures.get(row.symbol)?.features || dailyFeatures.get(row.symbol);
    const volume = dailyVolume(snapshot, todayDate);
    const chg = changePct(price, row.close || daily?.price);
    if (!price || price.price < 5 || snapshotDate(snapshot) !== todayDate) {
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
      const rvolScore = comparableRvolScore(row.symbol, intradayCache, calendar, today, now);
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
      return right.score - left.score || right.volume - left.volume || left.symbol.localeCompare(right.symbol);
    });
  }

  return { lists, unavailable };
}

function roundRobin(lists, limit = MAX_STRATEGY_SELECTED) {
  const keys = ["orb15", "gap_pullback", "vwap_reclaim", "reversal5"].filter((key) => lists[key]?.length);
  const selected = [];
  const seen = new Set();
  const indexes = Object.fromEntries(keys.map((key) => [key, 0]));

  while (selected.length < limit) {
    let moved = false;
    for (const key of keys) {
      while (indexes[key] < lists[key].length && seen.has(lists[key][indexes[key]].symbol)) {
        indexes[key] += 1;
      }
      const item = lists[key][indexes[key]];
      if (!item) continue;
      indexes[key] += 1;
      selected.push({ ...item, selectedFor: key });
      seen.add(item.symbol);
      moved = true;
      if (selected.length >= limit) break;
    }
    if (!moved) break;
  }
  return selected;
}

function rotation(rows, alreadySelected, count = ROTATION_COUNT) {
  const available = rows.filter((row) => !alreadySelected.has(row.symbol));
  if (!available.length || count <= 0) return [];
  const cursor = store.get("runtime", "selection-cursor")?.value || 0;
  const picks = [];
  for (let offset = 0; offset < Math.min(count, available.length); offset += 1) {
    picks.push(available[(cursor + offset) % available.length]);
  }
  store.put("runtime", "selection-cursor", { value: (cursor + picks.length) % available.length });
  return picks.map((row) => ({ ...row, selectedFor: "rotation" }));
}

function selectCandidates(input) {
  const { rows = [] } = input;
  const { lists, unavailable } = buildLists(input);
  const fromStrategies = roundRobin(lists, Math.min(MAX_STRATEGY_SELECTED, MAX_SELECTED));
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
    item.eligibleStrategies = [...(memberships.get(item.symbol) || new Set())];
  }
  return {
    selected,
    lists,
    unavailable,
    diagnostics: {
      selectedCount: selected.length,
      strategySelectedCount: fromStrategies.length,
      rotationCount: rotated.length,
      listSizes: Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, list.length])),
    },
  };
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
};

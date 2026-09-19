const VERSION = "v3-review-5m-latency0-basecost1";
const FIVE_MINUTES = 300000;

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sortedBars(bars) {
  return (bars || [])
    .filter((bar) =>
      Number.isFinite(Date.parse(bar?.t)) &&
      [bar.o, bar.h, bar.l, bar.c].every((value) => Number.isFinite(Number(value)) && Number(value) > 0),
    )
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
}

function firstEntryBar({ bars, plan, publishedAt, latencyMs = 0 }) {
  const eligibleAt = Date.parse(publishedAt) + latencyMs;
  const expiresAt = Date.parse(plan.expiresAt);
  if (!Number.isFinite(eligibleAt) || !Number.isFinite(expiresAt)) return null;
  return sortedBars(bars).find((bar) => {
    const start = Date.parse(bar.t);
    return start >= eligibleAt && start < expiresAt && bar.o >= plan.entry && bar.o <= plan.maxEntry && bar.o < plan.target;
  }) || null;
}

function exitAfterEntry({ bars, plan, entryBar, costPerSidePct = 0.0005 }) {
  const deadline = Date.parse(plan.deadline);
  const entryTime = Date.parse(entryBar.t);
  const entry = number(entryBar.o);
  const stop = number(plan.stop);
  const target = number(plan.target);
  if (![deadline, entryTime, entry, stop, target].every(Number.isFinite)) {
    return { outcomeStatus: "unresolved", reason: "invalid_plan" };
  }

  let lastClose = entry;
  let lastCloseAt = entryBar.t;
  for (const bar of sortedBars(bars).filter((item) => Date.parse(item.t) >= entryTime && Date.parse(item.t) <= deadline)) {
    const hitStop = bar.l <= stop;
    const hitTarget = bar.h >= target;
    lastClose = bar.c;
    lastCloseAt = new Date(Math.min(Date.parse(bar.t) + FIVE_MINUTES, deadline)).toISOString();
    if (hitStop && hitTarget) {
      return {
        outcomeStatus: "ambiguous",
        exit: stop,
        exitAt: lastCloseAt,
        exitReason: "stop_or_target_same_bar",
        ambiguous: true,
        conservativeExit: stop,
        optimisticExit: target,
      };
    }
    if (hitStop) {
      const gapExit = bar.o < stop ? bar.o : stop;
      return { outcomeStatus: "stop", exit: gapExit, exitAt: lastCloseAt, exitReason: "stop" };
    }
    if (hitTarget) {
      return { outcomeStatus: "target", exit: target, exitAt: lastCloseAt, exitReason: "target" };
    }
  }
  return { outcomeStatus: "time_exit", exit: lastClose, exitAt: lastCloseAt, exitReason: "deadline" };
}

function maxFavorableAdverse({ bars, entry, entryAt, until }) {
  const start = Date.parse(entryAt);
  const end = Date.parse(until);
  const sample = sortedBars(bars).filter((bar) => Date.parse(bar.t) >= start && Date.parse(bar.t) <= end);
  if (!sample.length || !Number.isFinite(entry)) return { mfePct: null, maePct: null };
  const maxHigh = Math.max(...sample.map((bar) => bar.h));
  const minLow = Math.min(...sample.map((bar) => bar.l));
  return {
    mfePct: ((maxHigh - entry) / entry) * 100,
    maePct: ((minLow - entry) / entry) * 100,
  };
}

function evaluateRecommendation({ recommendation, bars, horizon = "plan", latencyMs = 0, costPerSidePct = 0.0005, dataRevision = "alpaca:split" }) {
  const plan = recommendation.plan || {};
  const publishedAt = recommendation.publishedAt || recommendation.published_at || plan.createdAt;
  const entryBar = firstEntryBar({ bars, plan, publishedAt, latencyMs });
  const coverage = {
    barCount: sortedBars(bars).length,
    feed: recommendation.provenance?.intradayFeed || "unknown",
    timeframe: "5Min",
    dataRevision,
  };
  if (!coverage.barCount) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "retryable_error",
      outcomeStatus: "unresolved",
      metrics: {},
      coverage: { ...coverage, reason: "missing_bars" },
      ambiguity: { ambiguous: false },
    };
  }
  if (!entryBar) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "complete",
      outcomeStatus: "no_observed_fill",
      metrics: {},
      coverage,
      ambiguity: { ambiguous: false },
    };
  }
  const exit = exitAfterEntry({ bars, plan, entryBar, costPerSidePct });
  const entry = number(entryBar.o);
  const grossReturnPct = Number.isFinite(exit.exit) ? ((exit.exit - entry) / entry) * 100 : null;
  const costPct = costPerSidePct * 2 * 100;
  const netReturnPct = grossReturnPct == null ? null : grossReturnPct - costPct;
  const risk = entry - number(plan.stop);
  const rNet = Number.isFinite(risk) && risk > 0 && Number.isFinite(exit.exit)
    ? ((exit.exit - entry) - entry * costPerSidePct * 2) / risk
    : null;
  const excursions = maxFavorableAdverse({ bars, entry, entryAt: entryBar.t, until: exit.exitAt || plan.deadline });
  return {
    evaluatorVersion: VERSION,
    horizon,
    workflowStatus: "complete",
    outcomeStatus: exit.outcomeStatus,
    metrics: {
      entry,
      entryAt: entryBar.t,
      exit: exit.exit ?? null,
      exitAt: exit.exitAt ?? null,
      exitReason: exit.exitReason ?? null,
      grossReturnPct,
      netReturnPct,
      costPct,
      rNet,
      ...excursions,
    },
    coverage,
    ambiguity: {
      ambiguous: exit.ambiguous === true,
      conservativeExit: exit.conservativeExit ?? null,
      optimisticExit: exit.optimisticExit ?? null,
    },
  };
}

module.exports = {
  VERSION,
  evaluateRecommendation,
  firstEntryBar,
};

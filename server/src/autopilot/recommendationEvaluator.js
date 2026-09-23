const VERSION = "v3-review-5m-latency0-basecost2";
const SIP_QUOTES_VERSION = "v3-review-sip1m-quotes-cost2";
const FIVE_MINUTES = 300000;
const ONE_MINUTE = 60000;

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

function sortedQuotes(quotes) {
  return (quotes || [])
    .filter((quote) =>
      Number.isFinite(Date.parse(quote?.t)) &&
      Number.isFinite(Number(quote?.bidPrice)) &&
      Number.isFinite(Number(quote?.askPrice)) &&
      Number(quote.bidPrice) > 0 &&
      Number(quote.askPrice) > 0 &&
      Number(quote.bidPrice) <= Number(quote.askPrice),
    )
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
}

function finitePlan(plan, publishedAt, latencyMs) {
  const eligibleAt = Date.parse(publishedAt) + latencyMs;
  const expiresAt = Date.parse(plan.expiresAt);
  const deadline = Date.parse(plan.deadline);
  const entry = number(plan.entry);
  const maxEntry = number(plan.maxEntry);
  const stop = number(plan.stop);
  const target = number(plan.target);
  if (![eligibleAt, expiresAt, deadline, entry, maxEntry, stop, target].every(Number.isFinite)) return null;
  if (!(stop < entry && entry <= maxEntry && maxEntry < target && eligibleAt < expiresAt && expiresAt <= deadline)) return null;
  return { eligibleAt, expiresAt, deadline, entry, maxEntry, stop, target };
}

function coverageStatus({ bars, windowStart, windowEnd, requireDeadline = false }) {
  const sample = sortedBars(bars).filter((bar) => {
    const start = Date.parse(bar.t);
    return start >= windowStart && start < windowEnd;
  });
  if (!sample.length) return { ok: false, reason: "missing_window_bars", sample };
  const lastEnd = Date.parse(sample.at(-1).t) + FIVE_MINUTES;
  if (requireDeadline && lastEnd < windowEnd) return { ok: false, reason: "incomplete_deadline_coverage", sample };
  return { ok: true, sample };
}

function timeframeMs(timeframe = "5Min") {
  return timeframe === "1Min" ? ONE_MINUTE : FIVE_MINUTES;
}

function coverageStatusForTimeframe({ bars, windowStart, windowEnd, requireDeadline = false, timeframe = "5Min" }) {
  const sample = sortedBars(bars).filter((bar) => {
    const start = Date.parse(bar.t);
    return start >= windowStart && start < windowEnd;
  });
  if (!sample.length) return { ok: false, reason: "missing_window_bars", sample };
  const step = timeframeMs(timeframe);
  for (let index = 1; index < sample.length; index += 1) {
    const previous = Date.parse(sample[index - 1].t);
    const current = Date.parse(sample[index].t);
    if (current - previous > step * 1.5) return { ok: false, reason: "internal_bar_gap", sample };
  }
  const lastEnd = Date.parse(sample.at(-1).t) + step;
  if (requireDeadline && lastEnd < windowEnd) return { ok: false, reason: "incomplete_deadline_coverage", sample };
  return { ok: true, sample };
}

function firstEntryBar({ bars, plan, publishedAt, latencyMs = 0 }) {
  const parsed = finitePlan(plan, publishedAt, latencyMs);
  if (!parsed) return null;
  for (const bar of sortedBars(bars)) {
    const start = Date.parse(bar.t);
    if (start < parsed.eligibleAt || start >= parsed.expiresAt) continue;
    if (bar.o > parsed.maxEntry || bar.l <= parsed.stop) {
      return { invalidatedBeforeEntry: true, bar };
    }
    if (bar.o >= parsed.entry && bar.o <= parsed.maxEntry && bar.o < parsed.target) return bar;
  }
  return null;
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

  let lastClose = null;
  let lastCloseAt = null;
  for (const bar of sortedBars(bars).filter((item) => Date.parse(item.t) >= entryTime && Date.parse(item.t) < deadline)) {
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
  if (lastClose == null) return { outcomeStatus: "unresolved", reason: "missing_exit_bars" };
  return { outcomeStatus: "time_exit", exit: lastClose, exitAt: lastCloseAt, exitReason: "deadline" };
}

function maxFavorableAdverse({ bars, entry, entryAt, until }) {
  const start = Date.parse(entryAt);
  const end = Date.parse(until);
  const sample = sortedBars(bars).filter((bar) => Date.parse(bar.t) >= start && Date.parse(bar.t) < end);
  if (!sample.length || !Number.isFinite(entry)) return { mfePct: null, maePct: null };
  const maxHigh = Math.max(...sample.map((bar) => bar.h));
  const minLow = Math.min(...sample.map((bar) => bar.l));
  return {
    mfePct: ((maxHigh - entry) / entry) * 100,
    maePct: ((minLow - entry) / entry) * 100,
  };
}

function quoteOpportunity({ quotes, plan, publishedAt, latencyMs = 0, maxAgeMs = 30000 }) {
  const parsed = finitePlan(plan, publishedAt, latencyMs);
  if (!parsed) return { observed: false, reason: "invalid_plan" };
  const sample = sortedQuotes(quotes).filter((quote) => {
    const at = Date.parse(quote.t);
    return at >= parsed.eligibleAt && at < parsed.expiresAt;
  });
  if (!sample.length) return { observed: false, reason: "missing_quotes", quoteCount: 0 };
  const eligible = sample.filter((item) => {
    const at = Date.parse(item.t);
    return at - parsed.eligibleAt <= maxAgeMs && item.askPrice >= parsed.entry && item.askPrice <= parsed.maxEntry;
  });
  const quote = eligible[0];
  const staleCandidate = sample.find((item) => item.askPrice >= parsed.entry && item.askPrice <= parsed.maxEntry);
  if (!quote) return { observed: false, reason: staleCandidate ? "stale_quote" : "ask_outside_entry", quoteCount: sample.length, staleQuoteCandidateAt: staleCandidate?.t || null };
  const mid = (quote.bidPrice + quote.askPrice) / 2;
  return {
    observed: true,
    quoteAt: quote.t,
    ask: quote.askPrice,
    bid: quote.bidPrice,
    mid,
    spreadBps: mid > 0 ? ((quote.askPrice - quote.bidPrice) / mid) * 10000 : null,
    quoteCount: sample.length,
    crossed: quote.crossed === true,
    samplingRule: `first_ask_inside_entry_within_${maxAgeMs}ms_after_eligible_at`,
    staleQuoteCandidateAt: staleCandidate && staleCandidate !== quote ? staleCandidate.t : null,
  };
}

function horizonMovement({ recommendation, bars, horizon = "d0", referenceAt, timeframe = "1Min" }) {
  const plan = recommendation.plan || {};
  const publishedAt = recommendation.publishedAt || recommendation.published_at || plan.createdAt;
  const publishedMs = Date.parse(referenceAt || publishedAt);
  const sorted = sortedBars(bars).filter((bar) => Date.parse(bar.t) >= publishedMs);
  const observedReference = number(sorted[0]?.o);
  const entryReference = number(plan.entry);
  const last = sorted.at(-1);
  const high = sorted.length ? Math.max(...sorted.map((bar) => Number(bar.h))) : null;
  const low = sorted.length ? Math.min(...sorted.map((bar) => Number(bar.l))) : null;
  const close = number(last?.c);
  const coverage = {
    barCount: sorted.length,
    feed: recommendation.provenance?.intradayFeed || "sip",
    timeframe,
    dataRevision: "alpaca:sip:split:1min",
  };
  const step = timeframeMs(timeframe);
  let gap = false;
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index].t) - Date.parse(sorted[index - 1].t) > step * 1.5) gap = true;
  }
  if (!Number.isFinite(publishedMs) || sorted.length < 2 || close == null || observedReference == null || gap) {
    return {
      evaluatorVersion: SIP_QUOTES_VERSION,
      horizon,
      workflowStatus: "retryable_error",
      outcomeStatus: "unresolved",
      metrics: {},
      coverage: { ...coverage, reason: gap ? "internal_bar_gap" : sorted.length < 2 ? "insufficient_horizon_bars" : "invalid_reference", coverageStatus: "needs_data" },
      ambiguity: { ambiguous: false },
    };
  }
  return {
    evaluatorVersion: SIP_QUOTES_VERSION,
    horizon,
    workflowStatus: "complete",
    outcomeStatus: "movement_observed",
    metrics: {
      referencePrice: observedReference,
      referenceAt: sorted[0].t,
      planEntryReference: entryReference,
      close,
      closeAt: last.t,
      returnFromObservedReferencePct: ((close - observedReference) / observedReference) * 100,
      returnFromPlanEntryPct: entryReference ? ((close - entryReference) / entryReference) * 100 : null,
      mfeFromPlanEntryPct: Number.isFinite(high) ? ((high - entryReference) / entryReference) * 100 : null,
      maeFromPlanEntryPct: Number.isFinite(low) ? ((low - entryReference) / entryReference) * 100 : null,
    },
    coverage: { ...coverage, coverageStatus: "complete", firstBarAt: sorted[0].t, lastBarEndAt: new Date(Date.parse(last.t) + step).toISOString(), internalGaps: 0 },
    ambiguity: { ambiguous: false },
  };
}

function evaluateRecommendation({ recommendation, bars, horizon = "plan", latencyMs = 0, costPerSidePct = 0.0005, dataRevision = "alpaca:split" }) {
  const plan = recommendation.plan || {};
  const publishedAt = recommendation.publishedAt || recommendation.published_at || plan.createdAt;
  const parsed = finitePlan(plan, publishedAt, latencyMs);
  const sorted = sortedBars(bars);
  const coverage = {
    barCount: sorted.length,
    feed: recommendation.provenance?.intradayFeed || "unknown",
    timeframe: "5Min",
    dataRevision,
  };
  if (!parsed) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "unresolved",
      outcomeStatus: "unresolved",
      metrics: {},
      coverage: { ...coverage, reason: "invalid_plan" },
      ambiguity: { ambiguous: false },
    };
  }
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
  const entryCoverage = coverageStatus({ bars: sorted, windowStart: parsed.eligibleAt, windowEnd: parsed.expiresAt });
  if (!entryCoverage.ok) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "retryable_error",
      outcomeStatus: "unresolved",
      metrics: {},
      coverage: { ...coverage, reason: entryCoverage.reason },
      ambiguity: { ambiguous: false },
    };
  }
  const exitCoverage = coverageStatus({ bars: sorted, windowStart: parsed.eligibleAt, windowEnd: parsed.deadline, requireDeadline: true });
  if (!exitCoverage.ok) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "retryable_error",
      outcomeStatus: "unresolved",
      metrics: {},
      coverage: { ...coverage, reason: exitCoverage.reason },
      ambiguity: { ambiguous: false },
    };
  }
  const entryBar = firstEntryBar({ bars: sorted, plan, publishedAt, latencyMs });
  if (entryBar?.invalidatedBeforeEntry) {
    return {
      evaluatorVersion: VERSION,
      horizon,
      workflowStatus: "complete",
      outcomeStatus: "invalidated_before_entry",
      metrics: { invalidatedAt: entryBar.bar.t },
      coverage,
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
  SIP_QUOTES_VERSION,
  evaluateRecommendation,
  horizonMovement,
  quoteOpportunity,
  firstEntryBar,
};

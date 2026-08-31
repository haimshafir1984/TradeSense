// Enforces the parts of docs/SPEC_V2_ARCHITECTURE.md §5.8 that must never be optional UI copy:
// a 'provisional' playbook trades at half size, and 'hypothesis'/'backtested' playbooks are not
// tradeable with real money at all (backtested = historical evidence only, not yet measured
// forward - see the daily runbook §13.3 "don't trade backtested with real money").
const { round } = require('../services/mathUtils');
const { getRiskTier } = require('./riskTiers');

const PROVISIONAL_SIZE_MULTIPLIER = 0.5;
// Statuses that may size a real position at all. 'hypothesis' and 'backtested' are deliberately
// absent - there is no override path (§11 criterion 4/§1 rule 2).
const TRADEABLE_STATUSES = new Set(['provisional', 'active']);

// Returns the dollar amount that should be risked on this one trade, or null when it isn't
// tradeable yet for any reason (unknown tier, non-tradeable playbook status, missing/invalid
// account equity) - never 0, so "not allowed" stays distinguishable from "allowed but sized zero".
function computeAccountRiskUsd({ accountEquityUsd, riskTierKey, playbookStatus }) {
  const tier = getRiskTier(riskTierKey);
  if (!tier) {
    return null;
  }

  if (!TRADEABLE_STATUSES.has(playbookStatus)) {
    return null;
  }

  if (!Number.isFinite(accountEquityUsd) || accountEquityUsd <= 0) {
    return null;
  }

  const multiplier = playbookStatus === 'provisional' ? PROVISIONAL_SIZE_MULTIPLIER : 1;
  const effectivePct = tier.riskPerTradePct * multiplier;

  return round((accountEquityUsd * effectivePct) / 100, 2);
}

// Dollar value of the tier's daily loss cap, or null when the tier has no cap (conservative) or
// account equity isn't known.
function dailyLossCapUsd({ accountEquityUsd, riskTierKey }) {
  const tier = getRiskTier(riskTierKey);
  if (!tier || tier.dailyLossCapPct === null) {
    return null;
  }
  if (!Number.isFinite(accountEquityUsd) || accountEquityUsd <= 0) {
    return null;
  }

  return round((accountEquityUsd * tier.dailyLossCapPct) / 100, 2);
}

// True once today's realized loss has reached (or passed) the tier's cap - the daily runbook
// (§13.2/§13.3) treats this as a hard stop, not a suggestion. A tier with no cap never blocks.
function hasReachedDailyLossCap({ accountEquityUsd, riskTierKey, realizedLossUsdToday }) {
  const cap = dailyLossCapUsd({ accountEquityUsd, riskTierKey });
  if (cap === null) {
    return false;
  }

  const realized = Number.isFinite(realizedLossUsdToday) ? realizedLossUsdToday : 0;
  return realized >= cap;
}

// Whether one more position can be opened under the tier's concurrency limit.
function canOpenNewPosition({ riskTierKey, openPositionsCount }) {
  const tier = getRiskTier(riskTierKey);
  if (!tier) {
    return false;
  }

  const openCount = Number.isFinite(openPositionsCount) ? openPositionsCount : 0;
  return openCount < tier.maxConcurrentPositions;
}

module.exports = {
  computeAccountRiskUsd,
  dailyLossCapUsd,
  hasReachedDailyLossCap,
  canOpenNewPosition
};

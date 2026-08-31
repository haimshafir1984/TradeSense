// The three risk tiers from docs/SPEC_V2_ARCHITECTURE.md §5.5. A tier is a combination of which
// playbooks are allowed, position sizing, concurrency, market-cap range and horizon - not a score.
// Playbook keys match playbooks/index.js: pead_drift, gap_continuation, short_term_reversal,
// opening_range_breakout.
const RISK_TIERS = {
  conservative: {
    label: 'שמרני',
    playbooks: ['pead_drift', 'short_term_reversal'],
    riskPerTradePct: 0.5,
    maxConcurrentPositions: 3,
    // No daily loss cap at this tier - the horizon is weeks, a same-day cap doesn't map to how
    // these trades unfold (§5.5 table only defines a cap for balanced/aggressive).
    dailyLossCapPct: null,
    marketCap: { min: 10000000000, max: null },
    horizonDays: { min: 20, max: 60 }
  },
  balanced: {
    label: 'מאוזן',
    playbooks: ['pead_drift', 'gap_continuation', 'short_term_reversal'],
    riskPerTradePct: 1.0,
    maxConcurrentPositions: 5,
    dailyLossCapPct: 3,
    marketCap: { min: 2000000000, max: 200000000000 },
    horizonDays: { min: 3, max: 30 }
  },
  aggressive: {
    label: 'אגרסיבי',
    playbooks: ['opening_range_breakout', 'gap_continuation'],
    riskPerTradePct: 1.0,
    maxConcurrentPositions: 3,
    // Mandatory (§5.5): this is the tier where 93-95% of candidates won't actually jump.
    dailyLossCapPct: 2,
    marketCap: { min: 300000000, max: 10000000000 },
    horizonDays: { min: 0, max: 3 }
  }
};

function getRiskTier(tierKey) {
  return RISK_TIERS[tierKey] || null;
}

function listRiskTiers() {
  return Object.entries(RISK_TIERS).map(([key, tier]) => ({ key, ...tier }));
}

function isPlaybookAllowed(tierKey, playbookKey) {
  const tier = getRiskTier(tierKey);
  return Boolean(tier && tier.playbooks.includes(playbookKey));
}

function isMarketCapInRange(tierKey, marketCap) {
  const tier = getRiskTier(tierKey);
  if (!tier || !Number.isFinite(marketCap)) {
    return false;
  }

  if (marketCap < tier.marketCap.min) {
    return false;
  }
  if (tier.marketCap.max !== null && marketCap > tier.marketCap.max) {
    return false;
  }

  return true;
}

module.exports = {
  RISK_TIERS,
  getRiskTier,
  listRiskTiers,
  isPlaybookAllowed,
  isMarketCapInRange
};

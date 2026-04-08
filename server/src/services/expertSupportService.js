const STRATEGY_DISPLAY_LABELS = {
  micha_stocks: "השקעה לטווח ארוך - William O'Neil",
  mark_minervini: 'מסחר לטווח קצר - Mark Minervini',
  ross_cameron: 'מסחר יומי - Linda Bradford Raschke'
};

const PRIMARY_EXPERTS = {
  micha_stocks: {
    id: 'william_oneil',
    name: "William O'Neil",
    shortName: "O'Neil"
  },
  mark_minervini: {
    id: 'mark_minervini',
    name: 'Mark Minervini',
    shortName: 'Minervini'
  },
  ross_cameron: {
    id: 'linda_raschke',
    name: 'Linda Bradford Raschke',
    shortName: 'Linda Raschke'
  }
};

const SUPPORTING_EXPERTS = {
  micha_stocks: [
    {
      id: 'stan_weinstein',
      name: 'Stan Weinstein',
      shortName: 'Stan Weinstein',
      matches: (stock) =>
        stock.price > stock.MA200 &&
        stock.MA50 >= stock.MA200 &&
        Number(stock.highProximity || 0) >= 0.84
    },
    {
      id: 'peter_lynch',
      name: 'Peter Lynch',
      shortName: 'Peter Lynch',
      matches: (stock) =>
        stock.market_cap >= 5000000000 &&
        stock.price > stock.MA200 &&
        stock.volumeRatio >= 0.9 &&
        stock.volatility < 0.05
    }
  ],
  mark_minervini: [
    {
      id: 'brian_shannon',
      name: 'Brian Shannon',
      shortName: 'Brian Shannon',
      matches: (stock) =>
        stock.price > stock.MA50 &&
        stock.MA50 >= stock.MA200 &&
        Number(stock.highProximity || 0) >= 0.88 &&
        stock.volumeRatio >= 1
    },
    {
      id: 'oliver_kell',
      name: 'Oliver Kell',
      shortName: 'Oliver Kell',
      matches: (stock) =>
        Number(stock.relativeStrength || 0) >= 0.65 &&
        stock.daily_change > 0 &&
        Number(stock.highProximity || 0) >= 0.9
    }
  ],
  ross_cameron: [
    {
      id: 'ross_cameron',
      name: 'Ross Cameron',
      shortName: 'Ross Cameron',
      matches: (stock) =>
        stock.daily_change > 5 &&
        stock.volumeRatio > 2 &&
        Number(stock.price_near_daily_high || 0) >= 0.92
    },
    {
      id: 'tim_grittani',
      name: 'Tim Grittani',
      shortName: 'Tim Grittani',
      matches: (stock) =>
        stock.market_cap <= 10000000000 &&
        stock.volatility >= 0.04 &&
        stock.volumeRatio >= 1.8
    }
  ]
};

function assessExpertSupport({ stock, selectedStrategy }) {
  const primary = PRIMARY_EXPERTS[selectedStrategy] || PRIMARY_EXPERTS.micha_stocks;
  const supporters = (SUPPORTING_EXPERTS[selectedStrategy] || []).filter((expert) => expert.matches(stock));

  return {
    primary,
    supporters,
    supportCount: supporters.length,
    hasAdditionalSupport: supporters.length > 0,
    compactLabel: supporters.length ? `+${supporters.length}` : '0'
  };
}

function summarizeExpertSupport(results = []) {
  return results.reduce(
    (summary, result) => {
      const supportCount = Number(result.expertSupport?.supportCount || 0);

      if (supportCount >= 2) {
        summary.strong += 1;
      } else if (supportCount === 1) {
        summary.moderate += 1;
      } else {
        summary.none += 1;
      }

      return summary;
    },
    {
      strong: 0,
      moderate: 0,
      none: 0
    }
  );
}

module.exports = {
  STRATEGY_DISPLAY_LABELS,
  assessExpertSupport,
  summarizeExpertSupport
};

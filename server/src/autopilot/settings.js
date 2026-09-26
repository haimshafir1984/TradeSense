const store = require("./store");
const { ALL_STRATEGY_KEYS } = require("./strategies");
const DEFAULTS = {
  enabled: true,
  equity: 100,
  availableCash: 100,
  risk: "balanced",
  mode: "both",
  riskPct: 0.5,
  maxPositionPct: 30,
  maxPositions: 3,
  dailyLossPct: 2,
  fractional: true,
  fees: "none",
  slippagePct: 0.1,
  strategies: ["orb15", "orb15_retest", "gap_pullback", "vwap_reclaim", "vwap_pullback", "momentum_bull_flag", "reversal5"],
  excludedSymbols: [],
  setupComplete: false,
};
const ALLOWED_STRATEGIES = ALL_STRATEGY_KEYS;
function read(userId) {
  const saved = userId
    ? store.getUser(userId, "config", "settings")
    : store.get("config", "settings");
  return { ...DEFAULTS, ...saved };
}
function validate(input) {
  const out = {};
  const numbers = {
    equity: [1, 1000000],
    availableCash: [0, 1000000],
    riskPct: [0.1, 2],
    maxPositionPct: [1, 100],
    maxPositions: [1, 10],
    dailyLossPct: [0.5, 10],
    slippagePct: [0, 2],
  };
  for (const [key, [min, max]] of Object.entries(numbers))
    if (key in input) {
      if (
        typeof input[key] !== "number" ||
        !Number.isFinite(input[key]) ||
        input[key] < min ||
        input[key] > max ||
        (key === "maxPositions" && !Number.isInteger(input[key]))
      )
        throw new Error(`ערך לא תקין: ${key}`);
      out[key] = input[key];
    }
  for (const [key, allowed] of Object.entries({
    risk: ["balanced", "aggressive"],
    mode: ["both", "day", "swing"],
    fees: ["none", "paid", "free"],
  }))
    if (key in input) {
      if (!allowed.includes(input[key])) throw new Error(`ערך לא תקין: ${key}`);
      out[key] = input[key];
    }
  for (const key of ["enabled", "fractional", "setupComplete"])
    if (key in input) {
      if (typeof input[key] !== "boolean")
        throw new Error(`ערך לא תקין: ${key}`);
      out[key] = input[key];
    }
  if ("strategies" in input) {
    if (
      !Array.isArray(input.strategies) ||
      input.strategies.some((k) => !ALLOWED_STRATEGIES.includes(k))
    )
      throw new Error("אסטרטגיה לא מוכרת");
    out.strategies = [...new Set(input.strategies)];
  }
  if ("excludedSymbols" in input) {
    if (
      !Array.isArray(input.excludedSymbols) ||
      input.excludedSymbols.length > 100 ||
      input.excludedSymbols.some(
        (s) => typeof s !== "string" || !/^[A-Z]{1,5}$/.test(s),
      )
    )
      throw new Error("רשימת סימולים לא תקינה");
    out.excludedSymbols = [...new Set(input.excludedSymbols)];
  }
  return out;
}
function save(input, userId) {
  if (userId)
    return store.putUser(userId, "config", "settings", {
      ...read(userId),
      ...validate(input),
    });
  return store.put("config", "settings", { ...read(), ...validate(input) });
}
// Broker-neutral calculations: commissions, taxes and FX costs are outside the system's model.
function fee() {
  // TradeSense is broker-neutral. Broker commissions are recorded outside the
  // recommendation and tracking workflow and never constrain position sizing.
  return 0;
}
function size(plan, settings, reserved = 0) {
  const cash = Math.max(
    0,
    Math.min(
      settings.availableCash - reserved,
      (settings.equity * settings.maxPositionPct) / 100,
    ),
  );
  const risk = (settings.equity * settings.riskPct) / 100;
  const step = settings.fractional ? 0.0001 : 1;
  let lo = 0,
    hi = Math.max(0, Math.floor(cash / plan.entry / step));
  function costs(units) {
    const shares = units * step;
    const entryFee = fee(shares, plan.entry, settings.fees);
    const exitFee = fee(shares, plan.stop, settings.fees);
    return {
      shares,
      entryFee,
      exitFee,
      cost: shares * plan.entry + entryFee,
      riskUsd:
        shares * (plan.entry - plan.stop) +
        entryFee +
        exitFee +
        (shares * (plan.entry + plan.stop) * settings.slippagePct) / 100,
    };
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const c = costs(mid);
    if (c.cost <= cash && c.riskUsd <= risk) lo = mid;
    else hi = mid - 1;
  }
  const result = costs(lo);
  const netReward =
    result.shares * (plan.target - plan.entry) -
    result.entryFee -
    fee(result.shares, plan.target, settings.fees) -
    (result.shares * (plan.entry + plan.target) * settings.slippagePct) / 100;
  return {
    ...result,
    netReward,
    feasible:
      result.shares > 0 && result.shares * plan.entry >= 1 && netReward > 0,
    fractional: settings.fractional,
  };
}
module.exports = { DEFAULTS, read, save, validate, fee, size };

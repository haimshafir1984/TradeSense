# Backtest Strategy Definitions — TradeSense Historical Validation

Purpose: feed these definitions to Vibe-Trading (running locally, DeepSeek-driven) to
backtest the exact rules TradeSense's scanner uses, so we can answer "how would this
strategy have performed historically?" — a question the live app cannot answer today
(its strategy league only measures performance from when logging started).

Source of truth: `server/src/config/scoringConfig.js` and
`server/src/services/strategies.js`, as of 2026-07-18. This is a translation, not a
reimplementation — if the backtest engine can't express a rule exactly, it is
approximated and the approximation is called out explicitly (never silently dropped).

**This document does not change TradeSense's code or behavior.** It is a one-way
translation for use in a separate local tool.

---

## Strategy 1: small_cap_breakout (primary)

### Universe
- Exchange: NASDAQ or NYSE common stock (exclude ETFs, warrants, units, preferred shares)
- Market capitalization: below $2,000,000,000
- Price: $2.00 or above
- Average daily dollar volume: liquid enough to trade — use a $300,000 minimum daily
  share-volume floor as a proxy (this is the screener-level liquidity floor TradeSense
  uses; it is looser than any scoring threshold, just excludes untradable names)

### Hard eligibility gate (zero score if not met — do not rank on other factors)
- 20-day average daily range (ADR%), computed per-day as `(high − low) / low × 100`,
  averaged over the trailing 20 trading days: **≥ 5%**

### Entry signal (binary version, for backtest simulation)
On a given trading day, the stock is a "signal day" if ALL of the following hold:
1. `max(gap_pct, daily_change_pct) ≥ 4%`, where `gap_pct = (open − previous_close) /
   previous_close × 100` and `daily_change_pct = (close − previous_close) /
   previous_close × 100`
2. Volume ≥ 2× the trailing 30-day average daily volume
3. Close price ≥ 85% of the trailing 52-week high

### Original continuous scoring (for reference only — use if the backtest engine
supports a ranked/weighted signal rather than a binary trigger)
Weighted blend, each term normalized to [0,1] before weighting:
- Volume surge: `volume_ratio` normalized over the range [2×, 6×] of the 30-day
  average — weight **0.30**
- Momentum: `max(gap_pct, daily_change_pct)` normalized over [4%, 20%] — weight **0.30**
- Breakout: average of (a) `price / high_52w` normalized over [0.85, 1.00] and
  (b) a "consolidation score" (tightness of the last 20 days' trading range relative
  to the 52-week range — omit this sub-component if not easily reproducible; note the
  omission) — weight **0.25**
- Relative strength: the stock's trailing 3-month return minus SPY's trailing 3-month
  return over the same window, normalized over [−8%, +8%] — weight **0.15**
- Minimum score to count as a valid signal: **0.35** (on the 0–1 scale)

Note: `ADR%` is intentionally NOT part of the scoring formula — it only gates
eligibility above. Do not add it as a scoring factor; that would double-count the
same underlying volatility signal.

### Exit rules — IMPORTANT CONTEXT
**TradeSense has no exit logic at all.** It is a daily scanner, not a trading system —
it surfaces candidates each evening and stops there. The exit rules below are
invented for this backtest only, so results must be reported as "assuming a fixed
holding period," not as "what TradeSense would have done."

Run the backtest with THREE separate exit horizons, each as its own full run:
1. Sell at the close, 5 trading days after the signal day
2. Sell at the close, 10 trading days after the signal day
3. Sell at the close, 20 trading days after the signal day

Optional fourth variant if the engine supports intraday stop simulation: same as
horizon 3, but exit early if price ever closes 8% below the entry price
(stop-loss), whichever comes first.

### Benchmark
IWM (iShares Russell 2000 ETF), buy-and-hold over the same backtest period.

---

## Strategy 2: swing_momentum (secondary)

### Universe
Same as strategy 1, but WITHOUT the market-cap ceiling and price floor (this
strategy is not small-cap-specific — use TradeSense's general universe: liquid
NASDAQ/NYSE common stock).

### Hard eligibility gate
- ADR% (same 20-day definition as above): **≥ 3.5%**
- Close price above the 200-day moving average (MA200)

### Entry signal
The stock qualifies if EITHER of these two sub-setups triggers (take the stronger
one if both trigger on the same day):

**Sub-setup A — Breakout:**
1. MA50 > MA200 (uptrend structure)
2. Close price > MA50
3. Close price ≥ 85% of the trailing 52-week high
4. Volume ≥ 1.5× the trailing 30-day average
(Optional weighted scoring if the engine supports it: consolidation tightness 0.25,
proximity to 52w high 0.25, volume ratio normalized [1.5×, 3×] 0.20, relative
strength vs. SPY normalized [−8%,+8%] 0.20, trend flag (MA50>MA200 and
price>MA50) 0.10.)

**Sub-setup B — Episodic Pivot:**
1. `max(gap_pct, daily_change_pct) ≥ 8%`
2. Volume ≥ 2.5× the trailing 30-day average
(Optional weighted scoring: move-size normalized [8%,20%] weight 0.6, volume ratio
normalized [2.5×,5×] weight 0.4.)

### Exit rules
Same three horizons (5/10/20 trading days) as strategy 1. Same caveat: invented for
this backtest, not part of TradeSense's actual logic.

### Benchmark
SPY (S&P 500 ETF), buy-and-hold over the same backtest period.

---

## Strategy 3: Gap & Go watchlist (optional, only if time/budget remains)

### Universe
NASDAQ/NYSE, market cap below $10,000,000,000.

### Entry signal
All of:
1. `daily_change_pct > 0`
2. Volume ratio (today's volume / 30-day average) ≥ 1.2
3. ADR% (20-day) ≥ 3%

### Success metric — DIFFERENT FROM STRATEGIES 1 AND 2
This is not a holding-period return question. TradeSense already tracks this
manually today (the user logs actual next-day open prices against the model's
prior close). The metric to backtest is: **for stocks flagged on day T, what was the
opening print on day T+1, expressed as a percentage change from day T's close?**
Report the distribution (positive-gap rate, average gap%, median gap%) — this is
directly comparable to what's already being hand-logged in the live app.

No benchmark comparison needed for this one (it's a same-day microstructure
question, not a multi-day holding-period return).

---

## Requested output for every run

For each strategy × exit horizon combination:
- Number of signals generated over the backtest period (and signals/month)
- Win rate (% of trades with positive return)
- Average and median return per trade
- Cumulative return if every signal were taken with equal position sizing
- Maximum drawdown of the equity curve
- Comparison to the benchmark's buy-and-hold return over the same period
- If the engine supports it: the same metrics split by calendar year, so we can see
  whether performance concentrates in specific market regimes (bull/bear/choppy)

## Backtest period

3 years, ending on the most recent date the data provider covers. Use whatever the
default US-equity daily data source is (the tool advertises Tiingo/EOD-style free
data — that's fine for this purpose; note the actual provider used in the findings
report, since data quality/survivorship varies by source).

## Explicit non-goals

- Do not optimize parameters against the backtest ("curve-fit"). These are the
  rules as they exist in TradeSense's live code today — the point is to test them
  as-is, not to find better numbers.
- Do not attempt to model slippage, commissions, or realistic fill logic beyond
  whatever the engine does by default — note in the findings report whatever
  assumption was actually used.
- Do not enable or configure any live/paper broker connection for this work. This
  document is backtest-only.

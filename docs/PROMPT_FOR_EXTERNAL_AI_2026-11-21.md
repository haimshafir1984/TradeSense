# Prompt for ChatGPT and Gemini (copy everything below the line)

---

I run a paper-trading research system for US equities and I would like fresh, independent ideas. Below is what the system does, what logic it already contains, and what I have already tested without success. Please read it, then propose logic that is **different** from everything listed. I am not telling you what to look for. Think from first principles about where an edge could exist for a retail-scale, automated, long-only system, and then tell me how to test it honestly.

## 1. What the system is

- A paper-trading (demo accounts only, no real money) system for US stocks, two independent arms:
  - **Arm A:** 43 mega-cap stocks, signals executed through a retail MT4 demo account. Currently mostly "scan only".
  - **Arm B:** an Alpaca paper account (about $100K starting capital) trading volatile **small/mid-cap** stocks. This is the live experiment. It runs automatically during US market hours.
- Backend: Node.js with a single SQLite database. Data: Alpaca market data (free tier: IEX real-time for intraday; SIP only for historical and daily bars), plus Benzinga headlines via Alpaca and Finnhub for earnings dates.
- Constraints: long-only, no leverage, no options, no shorting, no pre-market data, no float/short-interest data, no L2 / order-book data, no paid data. Execution is a marketable limit order (IOC) with a small slippage cap. I am not a programmer; all logic must be mechanical and testable.

## 2. How Arm B works today

1. **Universe**, rebuilt daily: NASDAQ/NYSE stocks, price at least $3, 20-day average dollar volume between $3M and $150M, ranked by average daily range (high-low) over 20 days, top 150 kept. Funds/ETF-like names are labelled and not traded.
2. **Scan** every 5 minutes during regular hours on closed 5-minute candles (IEX): relative volume is computed as cumulative volume so far versus the stock's own 20-day average volume, scaled by elapsed time.
3. **Strategies currently evaluated** (all long-only, target always 2R, stop from candle structure):
   - `orb15`: opening-range breakout. The first 15 minutes define the range; a confirmed close above it on elevated relative volume.
   - `orb15_retest`: breakout above that range, a pullback that retests the level, then a confirming up candle.
   - `vwap_reclaim`: price crosses back above the intraday VWAP on elevated relative volume.
   - `vwap_pullback`: stock above VWAP pulls back to the VWAP zone and then closes up again.
   - `reversal5`: recovery after a sharp drop while the longer trend is still positive (swing, up to 5 days).
   - `pullback2_v1`: two down days inside an uptrend plus a recovery candle (swing).
   - `breakout20_v1`: close above the 20-session high in an uptrend (swing).
   - Two more (`gap_pullback`, `momentum_bull_flag`) exist but need a news flag and are switched off.
4. **Entry decision:** signals for one stock on one day are collected in a 5-minute window, scored (agreement between "families" of strategies, quality, a catalyst flag), and bought only above a minimum score (45).
5. **Sizing:** risk 0.75% of equity per trade (distance to stop), max 15% per position, max 5 open positions, 60% total exposure, 7% daily loss lock.
6. **Exits:** checked every 30 seconds: stop; move to break-even after +1R; sell 50% at 2R, then a rising stop and a trailing stop for the rest; everything closed at 15:55 New York time; any leftover position is closed at the next open. No orders outside regular hours.
7. **Learning / shadow data:** every signal the scanner finds, whether bought or not, is followed on the candles (would the stop or the 2R target have been hit first, max favorable/adverse excursion, the day's close). A 5-day follow-up with the same stop and target on daily bars is also recorded. Stored per signal: relative volume, ATR %, gap %, 20-day dollar volume, time of day, rank in the universe, trend flags, headline count and an "offering/dilution" headline flag. Shadow data is collection only and never affects trades.

## 3. What the live results look like (paper, small sample)

- Started at $100,000 on 2 November 2026. As of 20 November the account is about $86,100 (roughly -14%). One day (10 November) lost about 11% because of an exposure bug that was then fixed. Since then there have been five losing days in a row (about -0.3% to -1.3% each).
- Shadow results over six days of recorded signals (about 270 resolved signals; shadow has no costs and no slippage): the average result per signal was about -0.43R. Roughly 10% hit the 2R target first, about 68% hit the stop first, the rest ended near flat at the close. Every strategy was between -0.4R and -0.5R. On the last two days 58 of 65 signals were stopped out.
- The signals that were actually bought did worse than the ones that were skipped (about -0.65R versus -0.42R), and a higher entry score did not predict better results.
- A small slice that looked good after four days (relative volume above 5) shrank from about +0.3R to about +0.1R as more data arrived, which I regard as noise.
- Signals with a stop tighter than 1% of price lost about -0.8R on average (these stocks often have an ATR above 10% of price).
- Five-day follow-up (same stop and target, daily bars), one day of signals so far (42 signals, 27 stocks, 13 November): the same-day result averaged about +0.17R, but holding up to five days averaged about -0.66R. In 8 of the 42 cases the stock opened below the stop on a later day (gap through the stop), losing between 1.3R and 4.4R instead of 1R.

## 4. What I have already tested and that did NOT work

All of these were pre-registered (protocol frozen by hash before any return was calculated), long-only, with costs, against a control group, and with a development period separate from a locked validation period. None passed.

**Intraday and short-horizon rules**
- Opening-range breakout on "stocks in play" (published Sharpe above 2 in a well-known paper): not reproduced on my data; the result depends entirely on the unknowable order of events inside a one-minute candle. After realistic costs it was negative either way.
- Noise-area breakout on SPY (published Sharpe 1.2): it passed my development period (net about +0.01% per day) and then failed in the locked period (Sharpe -0.7). It also vanished at a cost of 0.02% per side.
- Late-day strength (+2% on the day, above VWAP, top of range, double volume) held overnight: gross +0.12%, net -0.03%, no better than random.
- Gap-and-go on small caps (gap of 5% or more, relative volume 2 or more, break of the first 5-minute high): 192 trades, negative even before costs, and no better than the same breakout without a gap.
- First 30 minutes of SPY predicts the last 30 minutes: no effect.
- A stock that refuses to fall when the market drops: gross close to zero.
- An abnormal drop then recovery: gross close to zero.
- Buy-low limit orders waiting for a dip: negative even with a very generous fill assumption.
- Forced buying of the underlying near the close by leveraged ETFs: zero, not significant.
- A sector leader moves and the related stock follows: negative.
- Trend plus short-term reversal on SPY and QQQ: failed.
- Headline-based ideas (guidance raised plus abnormal volume; an offering headline after a jump): either failed or too few events to decide.

**Multi-day holding (5 trading days, daily bars, 2021-2023 development)**
- On a universe mimicking the live one (volatile small/mid caps): continuation after a strong high-volume day, reversal after a sharp drop, and a 20-day-high breakout all lost money even before costs. A random pick in this universe itself lost about 1% per five days.
- On larger, more liquid stocks (dollar volume above $150M): the same three rules were still not better than random; continuation after a strong day was actually worse.
- A faithful-ish test of Mark Minervini's trend template with and without a volatility-contraction proxy: no tradable edge.
- Several earlier strategy-research rounds for the swing strategies: all negative.

**Things I did not or could not test:** order-book/auction data, short interest and borrow cost, options flow, pre-market data, float, social-media sentiment, fundamental data beyond a simple growth number.

## 5. What I would like from you

1. Propose **new** logic or a new framing that is materially different from everything above. Rank your ideas by how likely they are to survive honest testing, and say honestly which ones you think probably will not work.
2. For each idea: the economic or behavioural reason it might exist (why would the other side of the trade be willing to lose?), the exact mechanical rule, what data it needs (free data only unless you name a cheap paid one), the main ways it can fool me (survivorship, look-ahead, fill assumptions, costs), and a pre-registered test design with a pass/fail rule.
3. Tell me if you think the problem is the *universe* (small, volatile stocks) or the *time horizon* or the *idea itself*, and what you would test first to find out.
4. If you believe an automated long-only retail system at this scale has no realistic edge on free data, say so plainly and tell me what would change your mind.

Please do not just list popular indicators. I want ideas I have not already tried, with a clear reason for each.

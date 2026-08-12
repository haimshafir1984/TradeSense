# סקר GitHub — מערכות המלצות מניות ומסחר

תאריך ריצה: 2026-08-12T07:24:42.148Z
מקור: `docs/SPEC_GITHUB_SURVEY.md` (נוצר אוטומטית ע"י `npm run research:github --workspace server` — נדרס בכל ריצה)

**זו אינה המלצה לאמץ שום דבר מהרשימה, ואינה חוות דעת על איכות קוד.** הסקר קורא **מטא-דאטה בלבד** מ-GitHub (כוכבים, תיאור, תגיות, commit אחרון, רישיון) — הוא לא קורא שורת קוד אחת, ולכן אינו יכול לדעת אם פרויקט כלשהו סובל מ-lookahead bias, אם ה-backtest שלו כן, או אם הוא בכלל עובד. הטענה היחידה שהנתונים תומכים בה היא "זה קיים, ומתוחזק/לא מתוחזק".

## 1. פרמטרי הריצה

- מינימום כוכבים: 150
- commit אחרון מאז: 2025-02-18 (חלון של 540 ימים)
- אימות מול GitHub: ללא token (מכסה נמוכה)
- שאילתות קציר: 8 (`topic:algorithmic-trading`, `topic:quantitative-finance`, `topic:trading-strategies`, `topic:backtesting`, `topic:stock-market`, `topic:technical-analysis`, `topic:quantitative-trading`, `topic:trading-bot`)
- ריפוזיטוריז ייחודיים: 352

## 2. תמונת מצב כללית

- 107 מתוך 352 ריפוזיטוריז נושאים לפחות דגל אזהרה אחד.
- 53 ללא רישיון כלל — אסור לשימוש חוזר בקוד, גם אם הם נראים מעניינים.
- 128 לא נכנסו לאף קטגוריה — לרוב בוטים גנריים או אוספי קוד ללא ייעוד ברור.

## 3. עשרת הגדולים (לפי כוכבים)

מוצג כי זה מה שרוב האנשים ימצאו קודם — **לא** כי זה מה שהכי רלוונטי לנו.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 71788 | Python | NOASSERTION | 13ד | Open Data Platform for analysts, quants and AI agents. |  |
| [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 62365 | Python | MIT | 2ד | LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source mark |  |
| [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | 53202 | Python | GPL-3.0 | 0ד | Free, open source crypto trading bot |  |
| [microsoft/qlib](https://github.com/microsoft/qlib) | 47325 | Python | MIT | 20ד | Qlib is an AI-oriented Quant investment platform that aims to use AI tech to empower Quant Research, from exploring idea |  |
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 30655 | Python | MIT | 0ד | "Vibe-Trading: Your Personal Trading Agent" |  |
| [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 30124 | C++ | NOASSERTION | 1ד | FinceptTerminal is a modern finance application offering advanced market analytics, investment research, and economic da |  |
| [wilsonfreitas/awesome-quant](https://github.com/wilsonfreitas/awesome-quant) | 28705 | HTML | — | 0ד | A curated list of insanely awesome libraries, packages and resources for Quants (Quantitative Finance) | ללא רישיון - אסור לשימוש חוזר בקוד |
| [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | 21172 | C# | Apache-2.0 | 0ד | Lean Algorithmic Trading Engine by QuantConnect (Python, C#) |  |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21076 | Jupyter Notebook | MIT | 10ד | FinGPT: Open-Source Financial Large Language Models!  Revolutionize 🔥    We release the trained model on HuggingFace. |  |
| [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) | 20410 | Jupyter Notebook | MIT | 1ד | Code for Machine Learning for Trading, 3rd edition — from data sourcing to live execution. |  |

## 4. תוצאות לפי פער במערכת

כל סעיף פותח ב**למה זה מעניין אותנו** — הסקר מסודר סביב מה שחסר ב-TradeSense, לא סביב "מסחר" באופן כללי.

### יציאה, סטופים וגודל פוזיציה (23)

**למה זה מעניין אותנו:** הפער הגדול ביותר: TradeSense מייצר דירוג, לא עסקה - אין בו חוק יציאה או גודל פוזיציה.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [goldmansachs/gs-quant](https://github.com/goldmansachs/gs-quant) | 11942 | Python | Apache-2.0 | 6ד | Python toolkit for quantitative finance |  |
| [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | 8644 | Python | NOASSERTION | 10ד | The backtesting engine that gives you an unfair advantage. Run thousands of trading ideas before others finish one. |  |
| [PyPortfolio/PyPortfolioOpt](https://github.com/PyPortfolio/PyPortfolioOpt) | 5954 | Jupyter Notebook | MIT | 35ד | Financial portfolio optimization in python, including classical efficient frontier, Black-Litterman, Hierarchical Risk P |  |
| [JerBouma/FinanceToolkit](https://github.com/JerBouma/FinanceToolkit) | 5214 | Python | MIT | 1ד | Transparent and Efficient Financial Analysis |  |
| [dcajasn/Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib) | 4438 | C++ | BSD-3-Clause | 51ד | Portfolio Optimization in Python |  |
| [The-Swarm-Corporation/AutoHedge](https://github.com/The-Swarm-Corporation/AutoHedge) | 4157 | Python | MIT | 93ד | Build your autonomous hedge fund in minutes. AutoHedge harnesses the power of swarm intelligence and AI agents to automa |  |
| [0xemmkty/QuantMuse](https://github.com/0xemmkty/QuantMuse) | 2835 | Python | MIT | 379ד | A comprehensive quantitative trading system with AI-powered analysis, real-time data processing, and advanced risk manag | נטוש לכאורה (379 ימים ללא commit) |
| [skfolio/skfolio](https://github.com/skfolio/skfolio) | 2091 | Python | BSD-3-Clause | 12ד | Python library for portfolio optimization built on top of scikit-learn |  |
| [santoshlite/EigenLedger](https://github.com/santoshlite/EigenLedger) | 1074 | Python | Apache-2.0 | 332ד | An Open Source Portfolio Backtesting Engine for Everyone \| 面向所有人的开源投资组合回测引擎 |  |
| [AsyncAlgoTrading/aat](https://github.com/AsyncAlgoTrading/aat) | 828 | C++ | Apache-2.0 | 16ד | Asynchronous, event-driven algorithmic trading in Python and C++ |  |

### מנועי backtest (98)

**למה זה מעניין אותנו:** בדיקה עם עלויות עסקה ו-slippage, במקום backtest ידני שהומצא לצורך ריצה בודדת.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 30655 | Python | MIT | 0ד | "Vibe-Trading: Your Personal Trading Agent" |  |
| [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) | 20410 | Jupyter Notebook | MIT | 1ד | Code for Machine Learning for Trading, 3rd edition — from data sourcing to live execution. |  |
| [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 19416 | Python | Apache-2.0 | 1ד | Open source software that helps you create and deploy high-frequency crypto trading bots |  |
| [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) | 18312 | Jupyter Notebook | MIT | 154ד | [🔥updating ...] AI 自动量化交易机器人(完全本地部署) AI-powered Quantitative Investment Research Platform. 📃 online docs: https://ufun |  |
| [myhhub/stock](https://github.com/myhhub/stock) | 13766 | Python | Apache-2.0 | 132ד | stock股票.获取股票数据,计算股票指标,筹码分布,识别股票形态,综合选股,选股策略,股票验证回测,股票自动交易,支持PC及移动设备。 |  |
| [StockSharp/StockSharp](https://github.com/StockSharp/StockSharp) | 10550 | C# | NOASSERTION | 1ד | Algorithmic trading and quantitative trading open source platform to develop trading robots (stock markets, forex, crypt |  |
| [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger) | 10513 | Python | Apache-2.0 | 5ד | AI quantitative trading platform for crypto, stocks, and forex with backtesting, live trading, market data, and multi-ag |  |
| [kernc/backtesting.py](https://github.com/kernc/backtesting.py) | 8785 | Python | AGPL-3.0 | 7ד | 🔎 📈 🐍 💰  Backtest trading strategies in Python. |  |
| [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | 8644 | Python | NOASSERTION | 10ד | The backtesting engine that gives you an unfair advantage. Run thousands of trading ideas before others finish one. |  |
| [Drakkar-Software/OctoBot](https://github.com/Drakkar-Software/OctoBot) | 6366 | Python | GPL-3.0 | 1ד | Free open source crypto trading bot to automate AI, Grid, DCA and TradingView strategies on Binance, Hyperliquid and 15+ |  |

### ניתוח איכות פקטור (14)

**למה זה מעניין אותנו:** השאלה שלא נשאלה: האם הציון שהמערכת מחשבת בכלל מנבא תשואה עתידית.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [JerBouma/FinanceToolkit](https://github.com/JerBouma/FinanceToolkit) | 5214 | Python | MIT | 1ד | Transparent and Efficient Financial Analysis |  |
| [dcajasn/Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib) | 4438 | C++ | BSD-3-Clause | 51ד | Portfolio Optimization in Python |  |
| [cybergeekgyan/Quant-Developers-Resources](https://github.com/cybergeekgyan/Quant-Developers-Resources) | 3640 | - | — | 9ד | Resources to Prepare for Quant Developers/ Quantitative Researcher/ Quantitative Trader/ Quant Analyst/ Software Enginee | ללא רישיון - אסור לשימוש חוזר בקוד |
| [LLMQuant/quant-mind](https://github.com/LLMQuant/quant-mind) | 2509 | Python | MIT | 20ד | QuantMind is an agent-native knowledge extraction and retrieval framework for quantitative finance. |  |
| [Barca0412/Introduction-to-Quantitative-Finance](https://github.com/Barca0412/Introduction-to-Quantitative-Finance) | 1636 | Python | MIT | 0ד | AI+金融（量化）：1.多因子股票量化框架开源教程 2.学界和业界的经典资料收录 3.AI + 金融的相关工作，包括LLM, Agent, benchmark(evaluation), etc. |  |
| [ICT-FinD-Lab/alphagen](https://github.com/ICT-FinD-Lab/alphagen) | 1186 | Python | — | 69ד | Generating sets of formulaic alpha (predictive) stock factors via reinforcement learning. | ללא רישיון - אסור לשימוש חוזר בקוד |
| [Heerozh/spectre](https://github.com/Heerozh/spectre) | 819 | Python | GPL-3.0 | 484ד | GPU-accelerated Factors analysis library and Backtester | נטוש לכאורה (484 ימים ללא commit) |
| [Miasyster/QuantGPT](https://github.com/Miasyster/QuantGPT) | 433 | Python | MIT | 84ד | Agent-driven alpha factory — LLM autonomously designs, backtests, and submits factors to WorldQuant BRAIN |  |
| [nuglifeleoji/Factor-Research](https://github.com/nuglifeleoji/Factor-Research) | 416 | Jupyter Notebook | — | 355ד | Advanced Quantitative Factor Research: ML-powered stock return prediction with 72% performance improvement. Features com | ללא רישיון - אסור לשימוש חוזר בקוד |
| [cn-vhql/FactorHub](https://github.com/cn-vhql/FactorHub) | 390 | Python | — | 31ד | FactorHub is an open-source modern quantitative factor analysis platform designed specifically for the Chinese A-share m | ללא רישיון - אסור לשימוש חוזר בקוד |

### למידה מתוצאות (meta-labeling) (73)

**למה זה מעניין אותנו:** ללמוד מהתוצאות שנרשמו בפועל במקום להמציא עוד חוקים ידניים.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 71788 | Python | NOASSERTION | 13ד | Open Data Platform for analysts, quants and AI agents. |  |
| [microsoft/qlib](https://github.com/microsoft/qlib) | 47325 | Python | MIT | 20ד | Qlib is an AI-oriented Quant investment platform that aims to use AI tech to empower Quant Research, from exploring idea |  |
| [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 30124 | C++ | NOASSERTION | 1ד | FinceptTerminal is a modern finance application offering advanced market analytics, investment research, and economic da |  |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21076 | Jupyter Notebook | MIT | 10ד | FinGPT: Open-Source Financial Large Language Models!  Revolutionize 🔥    We release the trained model on HuggingFace. |  |
| [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) | 20410 | Jupyter Notebook | MIT | 1ד | Code for Machine Learning for Trading, 3rd edition — from data sourcing to live execution. |  |
| [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) | 18312 | Jupyter Notebook | MIT | 154ד | [🔥updating ...] AI 自动量化交易机器人(完全本地部署) AI-powered Quantitative Investment Research Platform. 📃 online docs: https://ufun |  |
| [bbfamily/abu](https://github.com/bbfamily/abu) | 18116 | Python | GPL-3.0 | 200ד | 阿布量化交易系统(股票，期权，期货，比特币，机器学习) 基于python的开源量化交易，量化投资架构 |  |
| [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | 15991 | Jupyter Notebook | MIT | 29ד | FinRL®:  Financial Reinforcement Learning. 🔥 |  |
| [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | 8644 | Python | NOASSERTION | 10ד | The backtesting engine that gives you an unfair advantage. Run thousands of trading ideas before others finish one. |  |
| [georgezouq/awesome-ai-in-finance](https://github.com/georgezouq/awesome-ai-in-finance) | 6388 | - | CC0-1.0 | 8ד | 🔬 A curated list of awesome LLMs & deep learning strategies & tools in financial market. |  |

### נתונים תוך-יומיים (37)

**למה זה מעניין אותנו:** כל המערכת עובדת על מחיר סגירה; בטווח קצר מחיר הכניסה בפתיחה הוא שקובע.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 62365 | Python | MIT | 2ד | LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source mark |  |
| [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 19416 | Python | Apache-2.0 | 1ד | Open source software that helps you create and deploy high-frequency crypto trading bots |  |
| [Open-Dev-Society/OpenStock](https://github.com/Open-Dev-Society/OpenStock) | 14065 | TypeScript | AGPL-3.0 | 39ד | OpenStock is an open-source alternative to expensive market platforms. Track real-time prices, set personalized alerts,  |  |
| [achannarasappa/ticker](https://github.com/achannarasappa/ticker) | 6187 | Go | GPL-3.0 | 44ד | Track stocks, crypto, and derivatives prices and positions in real time from your terminal |  |
| [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | 4350 | Rust | MIT | 232ד | Free, open source, a high frequency trading and market making backtesting and trading bot, which accounts for limit orde |  |
| [Mathieu2301/TradingView-API](https://github.com/Mathieu2301/TradingView-API) | 4263 | JavaScript | — | 50ד | 📈 Get real-time stocks from TradingView | ללא רישיון - אסור לשימוש חוזר בקוד |
| [The-Swarm-Corporation/AutoHedge](https://github.com/The-Swarm-Corporation/AutoHedge) | 4157 | Python | MIT | 93ד | Build your autonomous hedge fund in minutes. AutoHedge harnesses the power of swarm intelligence and AI agents to automa |  |
| [atilaahmettaner/tradingview-mcp](https://github.com/atilaahmettaner/tradingview-mcp) | 3942 | Python | MIT | 5ד | TradingView MCP server — real-time market data, technical analysis, screeners & backtesting for Claude, ChatGPT, Cursor  |  |
| [0xemmkty/QuantMuse](https://github.com/0xemmkty/QuantMuse) | 2835 | Python | MIT | 379ד | A comprehensive quantitative trading system with AI-powered analysis, real-time data processing, and advanced risk manag | נטוש לכאורה (379 ימים ללא commit) |
| [barter-rs/barter-rs](https://github.com/barter-rs/barter-rs) | 2224 | Rust | MIT | 67ד | Open-source Rust framework for building event-driven live-trading & backtesting systems |  |

### מונע-אירועים / קטליזטורים (22)

**למה זה מעניין אותנו:** תנועות של 12%+ מונעות מקטליזטור (דוח, FDA, הנפקה) - סריקת מחיר היא תמיד מאוחרת.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 62365 | Python | MIT | 2ד | LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source mark |  |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21076 | Jupyter Notebook | MIT | 10ד | FinGPT: Open-Source Financial Large Language Models!  Revolutionize 🔥    We release the trained model on HuggingFace. |  |
| [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) | 18312 | Jupyter Notebook | MIT | 154ד | [🔥updating ...] AI 自动量化交易机器人(完全本地部署) AI-powered Quantitative Investment Research Platform. 📃 online docs: https://ufun |  |
| [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) | 15449 | Python | MIT | 2ד | AI 时代的伯克希尔：基于 Claude Code / Codex 的价值投资研究框架。巴菲特·芒格·段永平·李录四大师方法论 + 多Agent并行研究。\| AI-era Berkshire: a value investing rese |  |
| [JerBouma/FinanceDatabase](https://github.com/JerBouma/FinanceDatabase) | 8328 | Python | MIT | 3ד | This is a database of 300.000+ symbols containing Equities, ETFs, Funds, Indices, Currencies, Cryptocurrencies and Money |  |
| [JerBouma/FinanceToolkit](https://github.com/JerBouma/FinanceToolkit) | 5214 | Python | MIT | 1ד | Transparent and Efficient Financial Analysis |  |
| [bukosabino/ta](https://github.com/bukosabino/ta) | 5142 | Jupyter Notebook | MIT | 147ד | Technical Analysis Library using Pandas and Numpy |  |
| [zvtvz/zvt](https://github.com/zvtvz/zvt) | 4259 | Python | MIT | 42ד | modular quant framework. |  |
| [Lumiwealth/lumibot](https://github.com/Lumiwealth/lumibot) | 1913 | Python | GPL-3.0 | 0ד | Backtestable AI trading agents and Python algorithmic trading strategies for stocks, options, crypto, futures, forex, SE |  |
| [lit26/finvizfinance](https://github.com/lit26/finvizfinance) | 1551 | Jupyter Notebook | MIT | 221ד | Finviz analysis python library. |  |

### זיהוי משטר שוק (1)

**למה זה מעניין אותנו:** לדעת מתי לא לסחור - לרוב משפר תוחלת יותר מכל שיפור בדירוג.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [mobilesitebytim/Forex-Trend-Dashboard-Engine](https://github.com/mobilesitebytim/Forex-Trend-Dashboard-Engine) | 153 | HTML | — | 0ד | 2026 MT5 Gateway: Institutional Trend Classifier & Multi-Asset Regime Dashboard | ללא רישיון - אסור לשימוש חוזר בקוד; מעט כוכבים - כמעט ללא ביקורת עמיתים |

### סורקים ומערכות המלצה (14)

**למה זה מעניין אותנו:** ההשוואה הישירה: איך אחרים בנו בדיוק את מה שכבר קיים כאן.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [atilaahmettaner/tradingview-mcp](https://github.com/atilaahmettaner/tradingview-mcp) | 3942 | Python | MIT | 5ד | TradingView MCP server — real-time market data, technical analysis, screeners & backtesting for Claude, ChatGPT, Cursor  |  |
| [shy3130/tickflow-stock-panel](https://github.com/shy3130/tickflow-stock-panel) | 2740 | Python | MIT | 1ד | TSP自托管、零运维的 A 股「选股 + 监控 + 回测」量化工作台 \| 基于 TickFlow 数据源  \| LLM能力驱使策略定制+个股分析+复盘 \| 自由接入第三方数据源与个性化扩展数据 \| 个人开源 ,非TickFlow官方 |  |
| [lit26/finvizfinance](https://github.com/lit26/finvizfinance) | 1551 | Jupyter Notebook | MIT | 221ד | Finviz analysis python library. |  |
| [deepentropy/tvscreener](https://github.com/deepentropy/tvscreener) | 1395 | JavaScript | Apache-2.0 | 30ד | TradingView Screener API - Stock, Crypto, Forex, Bond, Futures, Coin |  |
| [thinh-vu/vnstock](https://github.com/thinh-vu/vnstock) | 1372 | Python | NOASSERTION | 19ד | A beginner-friendly yet powerful Python toolkit for financial analysis and automation — built to make modern investing a |  |
| [shner-elmo/TradingView-Screener](https://github.com/shner-elmo/TradingView-Screener) | 1115 | Python | MIT | 1ד | A package that lets you create TradingView screeners in Python |  |
| [pranjal-joshi/Screeni-py](https://github.com/pranjal-joshi/Screeni-py) | 697 | Python | MIT | 3ד | A Python-based stock screener to find stocks with potential breakout probability from NSE India. |  |
| [BennyThadikaran/stock-pattern](https://github.com/BennyThadikaran/stock-pattern) | 401 | Python | GPL-3.0 | 253ד | A Python CLI tool to scan, detect, and plot stock chart patterns |  |
| [pkjmesra/PKScreener](https://github.com/pkjmesra/PKScreener) | 378 | Python | MIT | 19ד | A Python-based stock screener for NSE, India. PKScreener is an advanced free stock screener to find potential breakout s |  |
| [ling-0729/KHunter](https://github.com/ling-0729/KHunter) | 357 | Python | NOASSERTION | 54ד | KHunter 是一套开箱即用的A股量化交易系统，集数据管理、策略选股、择时交易、风险控制、回测验证于一体，为个人投资者提供从数据到交易的全流程量化解决方案。 |  |

### סוכני LLM למסחר (61)

**למה זה מעניין אותנו:** הקטגוריה שאליה שייך Vibe-Trading - כדי לדעת מה עוד קיים בכיוון הזה.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 71788 | Python | NOASSERTION | 13ד | Open Data Platform for analysts, quants and AI agents. |  |
| [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 62365 | Python | MIT | 2ד | LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source mark |  |
| [microsoft/qlib](https://github.com/microsoft/qlib) | 47325 | Python | MIT | 20ד | Qlib is an AI-oriented Quant investment platform that aims to use AI tech to empower Quant Research, from exploring idea |  |
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 30655 | Python | MIT | 0ד | "Vibe-Trading: Your Personal Trading Agent" |  |
| [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 30124 | C++ | NOASSERTION | 1ד | FinceptTerminal is a modern finance application offering advanced market analytics, investment research, and economic da |  |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21076 | Jupyter Notebook | MIT | 10ד | FinGPT: Open-Source Financial Large Language Models!  Revolutionize 🔥    We release the trained model on HuggingFace. |  |
| [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) | 20410 | Jupyter Notebook | MIT | 1ד | Code for Machine Learning for Trading, 3rd edition — from data sourcing to live execution. |  |
| [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 19416 | Python | Apache-2.0 | 1ד | Open source software that helps you create and deploy high-frequency crypto trading bots |  |
| [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | 15991 | Jupyter Notebook | MIT | 29ד | FinRL®:  Financial Reinforcement Learning. 🔥 |  |
| [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) | 15449 | Python | MIT | 2ד | AI 时代的伯克希尔：基于 Claude Code / Codex 的价值投资研究框架。巴菲特·芒格·段永平·李录四大师方法论 + 多Agent并行研究。\| AI-era Berkshire: a value investing rese |  |

### שכבת נתונים (32)

**למה זה מעניין אותנו:** חלופות ל-Alpaca/FMP/Finnhub, כולל נתונים שהמערכת כרגע לא מושכת בכלל.

| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |
|---|---|---|---|---|---|---|
| [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 62365 | Python | MIT | 2ד | LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source mark |  |
| [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger) | 10513 | Python | Apache-2.0 | 5ד | AI quantitative trading platform for crypto, stocks, and forex with backtesting, live trading, market data, and multi-ag |  |
| [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data) | 8635 | - | Apache-2.0 | 3ד | A股全栈数据工具包 · 10层架构 · 43端点(含3官方备胎) · 15数据源 · 行情/研报/资金面/筹码/公告/打板/ETF期权/舆情互动全覆盖+备用源降级 \| China A-Share full-stack data toolk |  |
| [JerBouma/FinanceToolkit](https://github.com/JerBouma/FinanceToolkit) | 5214 | Python | MIT | 1ד | Transparent and Efficient Financial Analysis |  |
| [shashankvemuri/Finance](https://github.com/shashankvemuri/Finance) | 4155 | Python | MIT | 139ד | 150+ quantitative finance Python programs to help you gather, manipulate, and analyze stock market data |  |
| [atilaahmettaner/tradingview-mcp](https://github.com/atilaahmettaner/tradingview-mcp) | 3942 | Python | MIT | 5ד | TradingView MCP server — real-time market data, technical analysis, screeners & backtesting for Claude, ChatGPT, Cursor  |  |
| [hello245m/free-stockdb](https://github.com/hello245m/free-stockdb) | 1998 | HTML | MIT | 1ד | 面向 A 股日K、分钟K与ETF分钟数据的本地量化引擎，集成增量同步、本地缓存、复权、批量查询、回测与指标计算。 |  |
| [alpacahq/alpaca-py](https://github.com/alpacahq/alpaca-py) | 1456 | Python | Apache-2.0 | 1ד | The Official Python SDK for Alpaca API |  |
| [TreborNamor/TradingView-Machine-Learning-GUI](https://github.com/TreborNamor/TradingView-Machine-Learning-GUI) | 976 | Python | MIT | 139ד | HyperView is a terminal-first TradingView strategy lab for downloading market data, backtesting Python strategies with P |  |
| [tradecatlabs/tradecat-public](https://github.com/tradecatlabs/tradecat-public) | 957 | Python | MIT | 22ד | 交易猫数据系统 |  |

## 5. מגבלות — לקרוא לפני שמסיקים משהו

1. **מטא-דאטה בלבד.** לא נקראה שורת קוד אחת. פרויקט עם 20,000 כוכבים יכול להיות backtest עם lookahead bias.
2. **כוכבים ≠ איכות.** דירוג לפי כוכבים מודד פופולריות ותשומת לב תקשורתית, לא נכונות סטטיסטית.
3. **הטיית שרידות הפוכה.** מי שבאמת מצא edge כמעט לעולם לא מפרסם אותו בקוד פתוח. מה שנמצא בסקר הוא, בהגדרה, מה שלא היה שווה מספיק כדי להסתיר.
4. **הקציר תלוי בתגיות.** GitHub מחפש בשם/תיאור/תגיות בלבד (לא ב-README), ולכן פרויקט מצוין שלא תייג את עצמו נכון פשוט לא קיים בסקר הזה.
5. **הסיווג הוא התאמת מילות מפתח.** שיוך לקטגוריה נעשה לפי מילים בתיאור, לא לפי מה שהקוד עושה — צפו לטעויות בשני הכיוונים.
6. **תצלום רגע.** הדוח נדרס בכל ריצה ומייצג את היום שבו רץ בלבד.

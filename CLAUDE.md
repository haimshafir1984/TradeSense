# CLAUDE.md

מסמך התמצאות קצר לתחילת שיחה חדשה של Claude Code בפרויקט הזה.

## TradeSense v2 — בנייה מחדש הושלמה (2026-08-31)

TradeSense עברה **בנייה מחדש מלאה**, לא שדרוג. ההוראה המחייבת היא **[docs/SPEC_V2_ARCHITECTURE.md](docs/SPEC_V2_ARCHITECTURE.md)** — לקרוא לפני כל שינוי קוד. כל 10 הפאזות ב-§10 הושלמו; המסמך הזה מתעד את המצב הנוכחי + כמה ממצאים חשובים מבדיקה חיה שלא היו ידועים בזמן כתיבת הספק.

**עקרון מנחה** (§0 בספק): המערכת לא מייצרת *דירוג* — היא מייצרת *עסקה שלמה*: כניסה/סטופ/יעד/time-stop/גודל. מועמד בלי תוכנית יציאה תקינה נפסל, לא מוצג.

## מבנה הקוד

```
server/src/
  providers/     alpacaService, nasdaqService, finnhubService — שכבת ה-API היחידה שמותר להסתמך עליה
  services/      universeStore, universeBuilderService, mathUtils, portfolioService, vibeTradingService, research/**
  pipeline/      liquidityGate, catalystService, selectionService, regimeGate, runScan, candidatesService
  playbooks/     peadDrift, shortTermReversal, gapContinuation, openingRangeBreakout, features, index
  risk/          exitEngine, riskTiers, positionSizing
  ledger/        ledgerStore, outcomeResolver, playbookStats, backfill
  routes/        candidates, playbooks, ledger, portfolio, backtest, anomalyMatch
client/src/
  App.jsx        מסך "סריקת מועמדים" (v2) + טאב "התיק שלי" (ללא שינוי)
```

**נמחק לחלוטין** (§2 בספק): `strategies.js`, `scannerService.js`, `analysisService.js`, `expertSupportService.js`, `indiOverlayService.js`, `opportunityScoringService.js`, `explanationService.js`, `marketRegimeService.js`, כל משפחת `watchlist*`, `funnelScanService.js`, `smallCapUniverseService.js`, `scanHistory*.js`, `marketDataService.js` (FMP), `barsStockBuilder.js`, `riskFramingService.js`, `regimeHistoryStore.js`, `shadowScanService.js`, `shareCountService.js`, `watchlistRerankService.js`, `wideScanUniverseService.js`, `config/scoringConfig.js`. כל הטסטים שלהם הוסרו איתם.

**נשאר ולא משולב במסלול v2** (§2): `services/vibeTradingService.js` + `routes/backtest.js` (בדיקה מול Vibe-Trading, on-demand מקומי), `services/research/**` + `routes/anomalyMatch.js` (כריית אנומליות, on-demand), `services/portfolioService.js`/`portfolioStore.js` (טאב "התיק שלי", ללא שינוי).

## ארבעת הפלייבוקים

| מפתח | עוצמת ראיות | רמות סיכון | מצב |
|---|---|---|---|
| `pead_drift` | חזקה | שמרני, מאוזן | פעיל |
| `short_term_reversal` | בינונית-חזקה | שמרני, מאוזן | פעיל |
| `gap_continuation` | חלשה (לא שפיט) | מאוזן, אגרסיבי | פעיל, **לא נתמך ב-`ledger:backfill`** (שחזור קטליזטור היסטורי יקר מדי) |
| `opening_range_breakout` | בינונית-חזקה | אגרסיבי בלבד | **כבוי** (`ORB_ENABLED`, נבדק בזמן קריאה לא בטעינת מודול). דורש `openingRangeHigh/Low/Direction` שהצנרת לא מזינה עדיין (אין נתונים תוך-יומיים ב-v1) |

כל פלייבוק מתחיל בדרגה `hypothesis` בסולם ארבע הדרגות (§5.8: `hypothesis → backtested → provisional → active`, אין קיצור דרך, backfill מקדם עד `backtested` בלבד). `docs/BACKFILL_FINDINGS.md` מכיל ריצה אמיתית (40 מניות, 24 חודשים) — `pead_drift` מראה איתות מוקדם מעודד (holdout n=35, hit-rate 71.4%) אך מתחת לסף ה-100 ל-`backtested`. הרצה מלאה: `npm run ledger:backfill --workspace server` (150 מניות).

## שני ממצאים חיים חשובים שלא היו ידועים בזמן כתיבת הספק

1. **מגבלת feed `iex` חמורה בהרבה בפועל מהצפוי.** נמדד: נפח MSFT דרך `iex` ≈ 1M מניות/יום, לעומת ~20-30M אמיתי (~4%, תואם למה שהספק כבר חזה). התוצאה: שער הנזילות (סף 1,000,000$, מקורו במחקר ORB עם נתוני SIP מלאים) פוסל היום חלק ניכר מהשוק — כולל מניות ענק כמו MSFT/GOOGL/META/TSLA. מריצה חיה על 1000 מניות: רק 19 עברו. **בכוונה לא תוקן** — זו ההחלטה מ-§12.2 (להמתין לנתוני ledger אמיתיים לפני שיקול שדרוג ל-SIP), לא תקלה.
2. **`catalystService`'s concurrency (5) גרם ל-`HTTP 429` מ-Finnhub** בסריקה על 400+ מניות. Fail-soft כמתוכנן (`catalyst: null`, לא קורס), אבל מפחית דיוק בסריקות גדולות — מועמד לטיפול עתידי (concurrency נמוך יותר / backoff).

## מוסכמות עבודה בריפו הזה

- טסטים: `node:test` + `node:assert/strict` תחת `server/test/` (`npm test --workspace server`, 285 טסטים). דפוס נפוץ: `delete require.cache[...]` לטעינה מחדש + ניקוי env vars ב-setup. **חשוב:** מודול שצריך שיהיה ניתן ל-mock (למשל נדרש ע"י `candidatesService`) חייב להיות `require`-ed כאובייקט namespace (`const foo = require('./foo')` + `foo.bar()`), **לא** דה-סטרוקטורינג (`const { bar } = require('./foo')`) — דה-סטרוקטורינג לוכד את הפונקציה בזמן ה-require ומונע מ-mock בטסט להגיע לקורא. נתקלנו בזה בפועל בפאזה 8.
- שינויי UI: להריץ dev server (Claude Browser preview tools) ולבדוק בפועל מול API אמיתי, לא רק unit tests — נתפסו כך גם באג CORS מקומי וגם ממצא ה-feed שלמעלה.
- `.env` בשורש: `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `CLIENT_ORIGIN` (**חייב לתאום לפורט שהלקוח באמת רץ עליו** — אחרת CORS חוסם כל קריאת API מהדפדפן בשקט), ואופציונלית `ORB_ENABLED`, `VIBE_TRADING_ENABLED`+`VIBE_TRADING_LAB_PATH`. לעולם לא לחשוף את תוכנו (גם לא ב-`cat`) — Read tool בלבד, ולא לצטט ערכי מפתחות בהודעות.
- build: `npm run build` (root) בונה את הלקוח ל-`client/dist`; לנקות אחרי בדיקה מקומית.
- Deploy: push ל-`main` → auto-deploy ב-Render (שני שירותים: server כ-Web Service, client כ-Static Site — ראו `docs/DEPLOYMENT.md`).

## מסמכים

- [README.md](README.md) — סקירה טכנית מלאה של v2.
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — הסבר לא-טכני.
- [docs/DAILY_RUNBOOK.md](docs/DAILY_RUNBOOK.md) — נוהל הפעלה יומי (גרסה מודפסת של §13 בספק).
- [docs/EXPLAINER.html](docs/EXPLAINER.html) — מסמך אינטראקטיבי (לפתוח בדפדפן).
- [docs/BACKFILL_FINDINGS.md](docs/BACKFILL_FINDINGS.md) — תוצאות מילוי היסטורי, נדרס בכל ריצת `ledger:backfill`.
- כלים עצמאיים ששרדו: `docs/SPEC_VIBE_TRADING_LAB.md`+`BACKTEST_FINDINGS.md` (Vibe-Trading), `SPEC_ANOMALY_MINING.md`+`ANOMALY_FINDINGS.md` (כריית אנומליות), `SPEC_GITHUB_SURVEY.md`+`GITHUB_SURVEY.md`.
- מסמכי v1 היסטוריים בלבד (מתארים קוד שנמחק, שימושיים רק להבנת §0 "למה בונים מחדש"): `SPEC_DATA_FUNNEL.md`, `SPEC_SMALL_CAP_STRATEGY.md`, `SPEC_UI_REDESIGN.md`, `SPEC_SHORT_TERM_UPGRADE.md`, `SPEC_NEW_STRATEGIES.md`, `LOGIC_IMPROVEMENTS.md`.

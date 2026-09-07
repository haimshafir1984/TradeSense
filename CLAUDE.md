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

כל פלייבוק מתחיל בדרגה `hypothesis` בסולם ארבע הדרגות (§5.8: `hypothesis → backtested → provisional → active`, אין קיצור דרך, backfill מקדם עד `backtested` בלבד). `docs/BACKFILL_FINDINGS.md` מעודכן מריצות אמיתיות (NASDAQ+NYSE, 800 מניות, 24 חודשים; 2,320 עסקאות ב-ledger) — **`pead_drift` עלה בפועל ל-`backtested`** (holdout: 1,484 עסקאות, hit-rate 63.8%, avgR 0.92, profit factor 4.0 — אומת חי דרך `GET /api/playbooks`). `short_term_reversal` נשאר `hypothesis` (holdout: 47 בלבד, מתחת לסף ה-100 — נדיר בכוונה, הרחבה נוספת (universe/בורסה) תעזור, לא עוד חודשים אחורה כי החלון קבוע). הרצה: `npm run ledger:backfill --workspace server -- --limit=800 --exchange=NASDAQ|NYSE`.

## שלושה ממצאים חיים חשובים

1. **מגבלת feed `iex` חמורה בהרבה בפועל מהצפוי — טופל 2026-08-31.** נמדד: נפח MSFT דרך `iex` ≈ 1M מניות/יום, לעומת ~20-30M אמיתי (~4%, תואם למה שהספק כבר חזה). שער הנזילות הישן (סף 1,000,000$, מקורו במחקר ORB עם נתוני SIP מלאים) פסל כמעט את כל השוק — כולל מניות ענק כמו MSFT/GOOGL/META/TSLA (מריצה חיה על 1000 מניות: רק 19 עברו). **הוחלט להוריד את סף `minAvgVolume20d` פי ~25 ל-`40,000`** (`pipeline/liquidityGate.js`) — תיקון פרופורציונלי ל-feed, לא כיול מחדש של המחקר. שווי שוק/מחיר/ATR14 לא שונו (לא תלויים ב-feed). אומת חי: מ-19/1000 עלה ל-531/1000. לשדרג בעתיד ל-SIP: לבטל את הכיול הזה בחזרה ל-1,000,000 (§12.2).
2. **`catalystService`'s concurrency (5) גרם ל-`HTTP 429` מ-Finnhub** בסריקה על 400+ מניות. Fail-soft כמתוכנן (`catalyst: null`, לא קורס), אבל מפחית דיוק בסריקות גדולות — מועמד לטיפול עתידי (concurrency נמוך יותר / backoff). **החמיר אחרי ממצא 1** — פי ~28 יותר מניות מגיעות עכשיו לשלב הקטליזטור.
3. **מחיר הכניסה שהכרטיס מציג הוא מחיר הסגירה של אתמול, לא מחיר חי — נמצא 2026-09-01, טרם תוקן.** כל עוד השוק פתוח, `alpacaService.getDailyBars` נועל `end` ליום המסחר הקודם (§7.1) - כל הפיצ'רים (מחיר, ATR, ממוצעים, נפח) קפואים על סגירת אתמול, ללא תלות בשעה שנלחץ "סרוק שוק". רק `premarketGapPct` (מ-`getSnapshots`) באמת חי. אומת ישירות מול Alpaca (2026-09-01): נר אחרון = סגירת 08-31 (317.14$), `latestTrade` באותו רגע = 316.15$. פירוט מלא + אפשרות תיקון ב-`docs/SPEC_V2_ARCHITECTURE.md` §14. עד שיוחלט: תג אזהרה נוסף ב-`docs/DAILY_RUNBOOK.md` (״וודא מול מסך הברוקר לפני הזנת פקודה״).

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

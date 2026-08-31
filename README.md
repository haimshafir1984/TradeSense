# TradeSense

TradeSense היא מערכת שמציגה **תוכניות מסחר שלמות** לטווח קצר — כניסה, סטופ, יעד, ומתי לצאת אם כלום לא קרה — במקום דירוג מניות בלבד. לקוח React 19/Vite + שרת Node/Express, npm workspaces (`client/`, `server/`).

> **הסבר פשוט למי שלא רוצה לצלול לפרטים הטכניים:** [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).
>
> **מדריך הפעלה יומי:** [docs/DAILY_RUNBOOK.md](docs/DAILY_RUNBOOK.md).
>
> **ההוראה המחייבת לארכיטקטורה:** [docs/SPEC_V2_ARCHITECTURE.md](docs/SPEC_V2_ARCHITECTURE.md) — כל שינוי קוד צריך להתיישר איתה.
>
> **מצב הבנייה מחדש + מפת קבצים לסשן חדש:** [CLAUDE.md](CLAUDE.md).
>
> **פורס ל-Render?** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## עקרון מנחה

מערכת v1 (הישנה) ייצרה *דירוג*. v2 מייצרת *עסקה שלמה*. מועמד בלי תוכנית יציאה תקינה **נפסל, לא מוצג** — לא משנה כמה הוא נראה טוב אחרת. ראו §0 ב-`SPEC_V2_ARCHITECTURE.md` לרקע המלא על למה זה נבנה מחדש.

## סקירה מהירה — הצנרת

```
GET /api/candidates?exchange=NASDAQ&riskTier=balanced&accountRiskUsd=200
```

1. **universe** — רשימת מניות שנבנית לילה (`universeStore.js`/`universeBuilderService.js`, Alpaca+Nasdaq+Finnhub).
2. **שער נזילות** (`pipeline/liquidityGate.js`) — מחיר/נפח/ATR/היסטוריה מינימליים, סף מקורו במחקר ORB.
3. **קטליזטור** (`pipeline/catalystService.js`) — הפתעת רווחים / דוח מתוזמן / ספייק חדשותי / גאפ ללא הסבר (מסומן כאזהרה).
4. **בחירה לפי נפח יחסי** (`pipeline/selectionService.js`) — Top-N לפי RVOL, השכבה שהמחקר מזהה כנושאת את רוב ה-edge.
5. **פלייבוקים** (`playbooks/*.js`) — ארבע לוגיקות מסחר קבועות, כל אחת עם `evaluate(stock, context)` משלה.
6. **מנוע יציאה** (`risk/exitEngine.js`) — סטופ/יעד/time-stop/גודל פוזיציה. מועמד בלי תוכנית תקינה נזרק.
7. **שער משטר שוק** (`pipeline/regimeGate.js`) — SPY מול MA200 + תנודתיות, חוסם רמות סיכון שלמות.
8. **ledger** (`ledger/*.js`) — כל מועמד שהוצג נרשם אוטומטית; תוצאות נפתרות מנתוני מחיר אמיתיים.

## ארבעת הפלייבוקים

| מפתח | שם | עוצמת ראיות | רמות סיכון | מצב |
|---|---|---|---|---|
| `pead_drift` | PEAD — דריפט אחרי הפתעת רווחים | חזקה | שמרני, מאוזן | פעיל |
| `short_term_reversal` | היפוך קצר-טווח | בינונית-חזקה | שמרני, מאוזן | פעיל |
| `gap_continuation` | המשך גאפ | חלשה (מקור מסחרי, לא שפיט) | מאוזן, אגרסיבי | פעיל |
| `opening_range_breakout` | פריצת טווח פתיחה (ORB) | בינונית-חזקה | אגרסיבי בלבד | **כבוי** (`ORB_ENABLED=false`) — דורש נתונים תוך-יומיים שלא מחוברים עדיין |

פירוט מלא (שערים, סטופ, יעד, מקורות) ב-§5.3 של `docs/SPEC_V2_ARCHITECTURE.md`.

## שלוש רמות סיכון

| | שמרני | מאוזן | אגרסיבי |
|---|---|---|---|
| סיכון לעסקה | 0.5% | 1.0% | 1.0% |
| תקרת הפסד יומית | — | 3% | 2% |
| שווי שוק | >10B$ | 2B-200B$ | 300M-10B$ |
| אופק | 20-60 יום | 3-30 יום | תוך-יומי-3 ימים |

## סולם ארבע הדרגות (ledger)

כל פלייבוק מתחיל ב-`hypothesis` ומתקדם רק לפי ראיות אמיתיות — **אין קיצור דרך**:

`hypothesis` (אין נתונים) → `backtested` (100+ עסקאות holdout היסטוריות, avgR חיובי) → `provisional` (10+ עסקאות קדימה שלא סותרות, חצי גודל פוזיציה) → `active` (30+ עסקאות קדימה, גודל מלא).

מילוי היסטורי (`npm run ledger:backfill --workspace server`) יכול לקדם עד `backtested` בלבד — לעולם לא ל-`active`. ראו `docs/BACKFILL_FINDINGS.md` לתוצאות עדכניות ו-§5.8 בספק לפרטים המלאים.

## מבנה הפרויקט

```text
server/src/
  providers/          # alpacaService, nasdaqService, finnhubService - שכבת ה-API היחידה
  services/           # universeStore, universeBuilderService, mathUtils, portfolioService, vibeTradingService, research/**
  pipeline/            # liquidityGate, catalystService, selectionService, regimeGate, runScan, candidatesService
  playbooks/           # peadDrift, shortTermReversal, gapContinuation, openingRangeBreakout, features, index
  risk/                # exitEngine, riskTiers, positionSizing
  ledger/              # ledgerStore, outcomeResolver, playbookStats, backfill
  routes/              # candidates, playbooks, ledger, portfolio, backtest, anomalyMatch
client/src/
  App.jsx              # מסך "סריקת מועמדים" + טאב "התיק שלי"
  components/PortfolioSection.jsx
```

## Endpoints

```
GET  /api/candidates?exchange=NASDAQ&riskTier=balanced[&playbook=pead_drift][&accountRiskUsd=200]
GET  /api/playbooks
GET  /api/ledger/stats[?playbook=pead_drift]
GET  /api/ledger/entries?limit=100
POST /api/ledger/resolve

GET  /api/portfolio, POST/DELETE .../holdings, .../watchlist   # ללא שינוי
GET  /api/backtest/status, POST /api/backtest/stock|theory      # Vibe-Trading, מקומי בלבד
GET  /api/anomaly-match/status, POST /api/anomaly-match/check   # כריית אנומליות, on-demand
```

## הרצה מקומית

```bash
npm install
npm run dev   # שרת על 4000, לקוח על 5173 (concurrently)
```

`.env` בשורש (לא ב-git): `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `CLIENT_ORIGIN` (חייב לתאום לפורט שהלקוח באמת רץ עליו - אחרת CORS חוסם כל קריאת API מהדפדפן), ואופציונלית `ORB_ENABLED`, `VIBE_TRADING_ENABLED`+`VIBE_TRADING_LAB_PATH`.

```bash
npm test --workspace server                                    # node:test, כל השירותים
npm run build                                                  # בונה את הלקוח ל-client/dist
npm run ledger:backfill --workspace server -- --months=24       # מילוי היסטורי (CLI ידני)
npm run ledger:resolve --workspace server                       # פתירת תוצאות (CLI ידני)
```

## מגבלות ידועות

1. **Feed נפח חלקי (`iex`).** מכסה ~4% מנפח השוק האמיתי. נמדד בפועל: MSFT מראה ~1M מניות/יום דרך iex לעומת ~20-30M אמיתי — שער הנזילות (סף שמקורו במחקר עם נתוני SIP מלאים) פוסל היום חלק ניכר מהשוק, כולל מניות ענק. הוחלט מפורשות להישאר על ה-feed החינמי עד שיהיה נתוני ledger אמיתיים (§12 החלטה 2).
2. **אין authentication.** המערכת פתוחה מקומית ללא מנגנון משתמשים.
3. **ORB כבוי כברירת מחדל.** דורש נתוני 5 דקות ותזמון בזמן אמת שלא נבנו ב-v1.
4. **`gap_continuation` לא נתמך ב-backfill.** שחזור היסטורי של קטליזטורים (חדשות/דוחות) יקר מדי על Finnhub החינמי על פני מאות מניות/ימים.
5. **אין authentication למסחר אמיתי בשום שלב** — המערכת מציגה תוכניות בלבד, לא מבצעת פעולות.

## מסמכים היסטוריים (v1, לרקע בלבד)

מסמכי v1 שמתארים קוד שנמחק (`docs/HOW_IT_WORKS.md` הישן, `SPEC_DATA_FUNNEL.md`, `SPEC_SMALL_CAP_STRATEGY.md`, `SPEC_UI_REDESIGN.md`, `SPEC_SHORT_TERM_UPGRADE.md`, `SPEC_NEW_STRATEGIES.md`, `LOGIC_IMPROVEMENTS.md`) נשארים בריפו כרקע היסטורי — שימושיים להבנת §0 ב-`SPEC_V2_ARCHITECTURE.md` ("למה בונים מחדש"), לא כתיאור עדכני. כלים עצמאיים ששרדו במלואם: `docs/SPEC_VIBE_TRADING_LAB.md`+`BACKTEST_FINDINGS.md` (Vibe-Trading), `SPEC_ANOMALY_MINING.md`+`ANOMALY_FINDINGS.md` (כריית אנומליות), `SPEC_GITHUB_SURVEY.md`+`GITHUB_SURVEY.md` (סקר קוד פתוח), `SPEC_UNIVERSE_RESILIENCE.md`+`SPEC_PROVIDER_REBALANCE.md` (עדיין מתארים נכון את שכבת ה-providers).

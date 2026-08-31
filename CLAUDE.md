# CLAUDE.md

מסמך התמצאות קצר לתחילת שיחה חדשה של Claude Code בפרויקט הזה.

## ⚠️ המערכת בבנייה מחדש (v2) — התחל מכאן

מ-2026-08-31 TradeSense עובר **בנייה מחדש מלאה**, לא שדרוג. ההוראה המחייבת היא **[docs/SPEC_V2_ARCHITECTURE.md](docs/SPEC_V2_ARCHITECTURE.md)** — תקרא אותה במלואה לפני כל שינוי קוד. שאר המסמך הזה (ותוכן README.md/docs/*.md הישן) מתאר את **מערכת v1 שנמחקת בהדרגה**; שימושי כרקע היסטורי, לא כתיאור של הקוד הקיים כרגע.

**עקרון מנחה של הבנייה מחדש** (§0 בספק): המערכת הישנה ייצרה *דירוג*; v2 מייצרת *עסקה שלמה* — כניסה/סטופ/יעד/time-stop/גודל. מועמד בלי תוכנית יציאה תקינה נפסל, לא מוצג.

### מצב נוכחי

| פאזה | תוצר | סטטוס |
|---|---|---|
| 0 | מחיקה + שרת עולה עם מסלול ריק | **הושלם** (2026-08-31) |
| 1 | ספקים + `getIntradayBars` + `getEarningsSurprises` | **הושלם** (2026-08-31) |
| 2 | מנוע יציאה + רמות סיכון (**קודם לכל פלייבוק**) | **הושלם** (2026-08-31) |
| 3 | pipeline: שער נזילות, קטליזטור, בחירה לפי נפח יחסי, שער משטר שוק, `runScan` + diagnostics | **הושלם** (2026-08-31) |
| 4 | פלייבוקים P4 (`short_term_reversal`) + P1 (`pead_drift`) | **הושלם** (2026-08-31) |
| 5 | פלייבוק P3 (`gap_continuation`) | **הושלם** (2026-08-31) |
| 6 | ledger: store, resolver, stats מפוצל forward/backfill, סולם 4 הדרגות | **הושלם** (2026-08-31) |
| 7 | `ledger:backfill` CLI + חלוקה כרונולוגית + `docs/BACKFILL_FINDINGS.md` | **הושלם** (2026-08-31) |
| 8-10 | ראו §10 בספק | ממתין |

**פאזה 6 - הערה:** `getPlaybookStatus` קיים אבל **עדיין לא מחובר** לפלייבוקים עצמם או ל-API - זה פאזה 8. השדה הסטטי `status: 'hypothesis'` על כל מודול פלייבוק הוא ברירת מחדל הגיונית (תואם מה ש-`determineStatus` היה מחזיר על ledger ריק), לא באג.

**פאזה 7 - הערות חשובות:**
- **תוקן באג אמיתי שנתפס בזמן הרצה אמיתית מול Alpaca/Finnhub (לא רק טסטים):** `ledgerStore.appendEntries` דרס כל `outcome` שהועבר אליו בקבוע `null` - כלומר ה-backfill היה "כותב" עסקאות שנפתרו במלואן, ואז מוחק את התוצאה שלהן ברגע השמירה. נתפס כי ריצה אמיתית הראתה `49 trades written` אבל הדוח הציג `n=0` בכל מקום. תוקן + נוסף טסט רגרסיה ב-`ledgerStore.test.js`.
- `gap_continuation` **אינו נתמך ב-backfill** (`SUPPORTED_PLAYBOOK_KEYS = ['pead_drift', 'short_term_reversal']`) - שחזור היסטורי של קטליזטורים (חדשות/דוחות) יקר מדי על Finnhub החינמי על פני מאות מניות/ימים. מתועד בדוח, לא מוסתר.
- `docs/BACKFILL_FINDINGS.md` שבריפו הוא **ריצה אמיתית אך מצומצמת** (40 מניות, 24 חודשים, שני הפלייבוקים הנתמכים) שהופעלה כדי לוודא שהצנרת עובדת מקצה לקצה מול Alpaca/Finnhub האמיתיים - לא ריצה מלאה. `pead_drift` כבר מראה איתות מוקדם מעודד (holdout: n=35, hit-rate 71.4%, avgR 1.44) אך עדיין מתחת לסף ה-100 עסקאות ל-`backtested`. להרצה מלאה: `npm run ledger:backfill --workspace server` (ברירת מחדל: 150 מניות, 24 חודשים).

**פאזה 4 - הערה:** שני הפלייבוקים במצב `hypothesis` (סולם §5.8), **לא מחוברים ל-`runScan`** - זה חלק מפאזה 8. `dailyChangePct` ב-`features.js` הוא קירוב ל"תשואת יום-הדוח" של PEAD כי אין לנו נר תוך-יומי מדויק של רגע התגובה, רק נרות יומיים.

**פאזה 3 - הערה:** `runScan.js` בונה shortlist מלא (universe → נזילות → קטליזטור → בחירה → משטר), אבל **עדיין לא כולל הערכת פלייבוקים** (זה פאזות 4/5/9) ו-**`routes/candidates.js` עדיין placeholder** - החיווט ל-route האמיתי הוא פאזה 8 במפורש (§10), לא נעשה מוקדם.

**מה נשאר מהמערכת הישנה** (§3 בספק — זה כל מה שמותר להסתמך עליו):
- `server/src/providers/` (הועבר מ-`services/providers/`, ללא שינוי תוכן) — `alpacaService.js`, `nasdaqService.js`, `finnhubService.js`
- `server/src/services/universeStore.js` + `universeBuilderService.js` — תשתית ה-universe הלילית. **הערה:** ה-scheduler שהפעיל את הרענון הלילי (`watchlistScheduler.js`) נמחק עם משפחת ה-watchlist; הרענון עדיין קורה lazy (בזמן בקשה), אבל אין עוד "חימום" אוטומטי בלילה — לתעד/לפתור בפאזה מתאימה.
- `server/src/services/mathUtils.js` — כולל `computeRsi`/`computeTrailingReturnPct`. `scoreConsolidation` נשאר בניגוד ל-§3.5 בספק כי `services/research/asOfFeatures.js` (שנשאר כמות שהוא) תלוי בו.
- `server/src/services/portfolioService.js`/`portfolioStore.js` — פיצ'ר נפרד, נשאר. שוכתב פנימית להשתמש ב-`alpacaService.getSnapshots` במקום ב-`marketDataService` שנמחק (שם/סקטור כבר לא זמינים דרך זה — נופלים ל-ticker/'Unknown', לא regression).
- `server/src/services/vibeTradingService.js` + `server/src/services/research/**` — כלים ידניים עצמאיים, **לא** משולבים במסלול v2. `vibeTradingService.js` שוכתב עם קבוע `SMALL_CAP_THRESHOLDS` מקומי (היה ב-`config/scoringConfig.js` שנמחק) כדי לשמר התנהגות זהה.
- Routes ששרדו: `routes/portfolio.js`, `routes/backtest.js` (Vibe-Trading, on-demand), `routes/anomalyMatch.js` (כריית אנומליות, on-demand — עצמאי, לא תלוי במסלול הסריקה).
- `routes/candidates.js` — placeholder בלבד כרגע, מחזיר `warnings` שמסביר שהמסלול טרם מומש.

**נמחק לחלוטין** (§2 בספק): `strategies.js`, `scannerService.js`, `analysisService.js`, `expertSupportService.js`, `indiOverlayService.js`, `opportunityScoringService.js`, `explanationService.js`, `marketRegimeService.js`, כל משפחת `watchlist*`, `funnelScanService.js`, `smallCapUniverseService.js`, `scanHistory*.js`, `marketDataService.js` (FMP), `barsStockBuilder.js`, `riskFramingService.js`, `regimeHistoryStore.js`, `shadowScanService.js`, `shareCountService.js`, `watchlistRerankService.js`, `wideScanUniverseService.js`, `config/scoringConfig.js`, וה-routes המתאימים. כל הטסטים שלהם הוסרו יחד איתם.

**`client/src/App.jsx` עדיין לא נגע בו** — הוא הריפו ל-`/api/analyze`/`/api/watchlist`/`/api/scan-history`/`/api/strategy-league` שנמחקו. הבנייה מחדש של הלקוח היא **פאזה 8** במפורש. עד אז: הלקוח נבנה בהצלחה (`npm run build` עובר), אבל טאבי "סריקת שוק" ו"רשימת מעקב" יחזירו שגיאות רשת בזמן ריצה - זה מצב ביניים צפוי, לא רגרסיה שצריך לתקן מוקדם.

**מוסכמת commit:** commit נפרד לכל פאזה מ-§10, כל commit מעדכן את הטבלה למעלה.

---

## מה שמתחת לכאן מתאר את v1 (רקע היסטורי בלבד)

## מה זה TradeSense (v1 — נמחקת בהדרגה)

מערכת סריקת מניות: לקוח React 19/Vite + שרת Node/Express, npm workspaces (`client/`, `server/`). ה-README.md ומסמכי docs/SPEC_*.md הישנים מתעדים את הארכיטקטורה, האסטרטגיות, ומשפך הנתונים של v1 — שימושי להבנת *למה* v2 נבנתה כמו שהיא (ראו §0 ב-`SPEC_V2_ARCHITECTURE.md`), לא כתיאור עדכני.

מסמכים רלוונטיים עדיין (לא נמחקו, לא תלויים בקוד שנמחק):
- `docs/SPEC_VIBE_TRADING_LAB.md`, `docs/BACKTEST_STRATEGY_DEFINITIONS.md`, `docs/BACKTEST_FINDINGS.md`, `docs/SPEC_VIBE_TRADING_INTEGRATION.md` — כלי ה-backtest החיצוני, עדיין רלוונטי כי `vibeTradingService.js` שרד.
- `docs/SPEC_ANOMALY_MINING.md`, `docs/ANOMALY_FINDINGS.md`, `docs/SPEC_GITHUB_SURVEY.md`, `docs/GITHUB_SURVEY.md` — כלי המחקר תחת `services/research/**`, שרדו במלואם.
- `docs/SPEC_UNIVERSE_RESILIENCE.md`, `docs/SPEC_PROVIDER_REBALANCE.md` — עדיין מתארים נכון את `universeStore.js`/`universeBuilderService.js` ואת שרשרת הספקים (בלי שכבת ה-FMP שהוסרה).

מסמכים שהפכו להיסטוריים בלבד (מתארים קוד שנמחק): `docs/HOW_IT_WORKS.md`, `docs/SPEC_DATA_FUNNEL.md`, `docs/SPEC_SMALL_CAP_STRATEGY.md`, `docs/SPEC_UI_REDESIGN.md`, `docs/SPEC_SHORT_TERM_UPGRADE.md`, `docs/SPEC_NEW_STRATEGIES.md`, `docs/LOGIC_IMPROVEMENTS.md`, `docs/EXPLAINER.html`.

## מוסכמות עבודה בריפו הזה

- טסטים: `node:test` + `node:assert/strict` תחת `server/test/` (`npm test --workspace server`). דפוס נפוץ: `delete require.cache[...]` לטעינה מחדש של מודול + ניקוי env vars ב-setup.
- שינויי UI: להריץ dev server (Claude Browser preview tools) ולבדוק בפועל.
- `.env` בשורש הוא ה-source of truth למפתחות מקומיים ומ-gitignore (`git check-ignore -v .env` מאשר). לעולם לא לחשוף את תוכנו (אפילו לא ב-`cat`/הדפסה לטרמינל) - להשתמש ב-Read tool בלבד כשצריך לבדוק מבנה, ולא לצטט ערכי מפתחות בהודעות.
- build: `npm run build` (root) בונה את הלקוח ל-`client/dist`; לנקות אחרי בדיקה מקומית לפי המוסכמה הקיימת בפרויקט.
- Deploy: push ל-`main` -> auto-deploy ב-Render (שני שירותים נפרדים: server כ-Web Service, client כ-Static Site — ראו `docs/DEPLOYMENT.md`). **בזמן הבנייה מחדש: כל פאזה חייבת להשאיר את שני השירותים עולים ומגיבים**, גם אם המסלול עדיין חלקי (§12.1 בספק).

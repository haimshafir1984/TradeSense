# CLAUDE.md

מסמך התמצאות קצר לתחילת שיחה חדשה של Claude Code בפרויקט הזה. המסמכים המפורטים נמצאים ב-README.md ותחת docs/ - זה לא תחליף להם, רק מפה + הקשר טרי.

## מה זה TradeSense

מערכת סריקת מניות: לקוח React 19/Vite + שרת Node/Express, npm workspaces (`client/`, `server/`). המשתמש בוחר בורסה/סיכון/אסטרטגיה, השרת סורק universe של מניות, מפעיל פילטרים קשיחים ומנקד לפי 5 אסטרטגיות (`server/src/services/strategies.js`: Micha, Minervini, Ross, Swing Momentum, Small-Cap Breakout), ומחזיר עד 10 תוצאות מדורגות עם הסבר.

**התחל תמיד מ-[README.md](README.md)** (סקירה טכנית מלאה) ומ-[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) (הסבר בשפה פשוטה). זה המסמך היחיד שנשמר מעודכן שוטף.

## מפת docs/

- `HOW_IT_WORKS.md` - הסבר לא-טכני "מה המערכת עושה".
- `DEPLOYMENT.md` - פריסה ל-Render (env vars, מכשולים אמיתיים).
- `TESTING_PLAN.md` - פרוטוקול בדיקה מול כסף אמיתי.
- `SPEC_DATA_FUNNEL.md`, `SPEC_SMALL_CAP_STRATEGY.md`, `SPEC_UI_REDESIGN.md`, `SPEC_MANUAL_TESTING_TOOLS.md` - ספקים היסטוריים לתכונות קיימות.
- `SPEC_PROVIDER_REBALANCE.md` - למה ה-universe הראשי עבר מ-FMP ל-Alpaca+Nasdaq.
- `SPEC_UNIVERSE_RESILIENCE.md` - הרענון הלילי של ה-universe (`universeStore.js` + `universeBuilderService.js`), נשמר לדיסק כדי שסריקות יומיות לא יתלו ברשת/יחסמו.
- `LOGIC_IMPROVEMENTS.md` - ממצאים ידועים + backlog לשיפור לוגיקת ההמלצות.
- `SPEC_VIBE_TRADING_LAB.md`, `BACKTEST_STRATEGY_DEFINITIONS.md`, `BACKTEST_FINDINGS.md` - מעבדת ה-backtest הנפרדת (ראו למטה).
- `SPEC_VIBE_TRADING_INTEGRATION.md` - האינטגרציה בפועל בתוך TradeSense (ראו למטה).
- `SPEC_SHORT_TERM_UPGRADE.md` - **הושלם (2026-07-18)**: שדרוג טווח-קצר/high-risk ב-9 שלבים, כל שלב ב-commit נפרד. תקציר התוצאה: הקלטת-צל לילית, מסגור R, כיול hit-rate נמדד, סריקה רחבה, float/קטליזטורים אמיתיים, regime מוחלק, דירוג-מחדש פרה-מרקט, universe שיטתי ל-Vibe-Trading, ותיעוד (ראו סעיף 7.9 ב-`LOGIC_IMPROVEMENTS.md` לפירוט מלא לפי שלב).
- `SPEC_ANOMALY_MINING.md` - **הושלם (2026-07-25), הורחב באותו יום**: כלי CLI (הכרייה עצמה - CLI ידני בלבד, לעולם לא אוטומטי) שגילה חוקים מהנתונים במקום לייבא אותם מבחוץ - סורק שנה של stock-days ב-NASDAQ ומחפש תבניות שקדמו לקפיצה של 12%+ ביום בודד, נבדקות מול base rate ומאומתות ב-holdout כרונולוגי. תוצאות ומגבלות ב-`docs/ANOMALY_FINDINGS.md` (נוצר מחדש בכל ריצה). התוצאות **גם מוצגות בטבלת הסריקה** (endpoint חדש, ראו למטה) - חריגה מודעת מהתכנון המקורי, ראו סעיף 11 בספק.

## התוסף Vibe-Trading (נוסף 2026-07-18)

שתי תכונות נפרדות, שתיהן **ביוזמת משתמש בלבד, אף פעם לא אוטומטיות**:

1. **מעבדת backtest עצמאית** - כלי חיצוני [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) מותקן בתיקייה **נפרדת לגמרי מהריפו הזה**, `~/Projects/vibe-trading-lab` (venv Python משלו), עם DeepSeek כ-LLM provider. שימש לאימות (לא לשיפור) חוקי `small_cap_breakout`/`swing_momentum` על מדגם קבוע של מניות. תוצאות ומגבלות (הכי חשוב: selection bias - מדגם ידני, לא universe אמיתי) ב-`docs/BACKTEST_FINDINGS.md`.
2. **אינטגרציית "רמה 2" בתוך TradeSense עצמו** - שני כפתורים בטאב סריקת שוק:
   - "בדוק היסטורית" ליד כל מניה בתוצאות - בודק מה המניה עצמה עשתה בעבר כשהראתה תבנית דומה.
   - "בדוק תאוריה היסטורית" ליד סרגל המטא - מריץ שוב את אותו backtest קבוע-universe על החוקים הנוכחיים.
   
   קבצים: `server/src/services/vibeTradingService.js` (spawn ל-CLI, single-flight, timeout 3 דק', feature flag), `server/src/routes/backtest.js` (`GET /status`, `POST /stock`, `POST /theory`), `client/src/App.jsx` (הכפתורים + `BacktestReportModal`), `server/test/vibeTradingService.test.js`.

   **מוסתר לגמרי כברירת מחדל ולא קיים ב-Render** - דורש `VIBE_TRADING_ENABLED=true` + `VIBE_TRADING_LAB_PATH=...` ב-`.env` המקומי (לא מוגדר ולא צריך להיות מוגדר בפריסה). שום קוד קיים לא קורא ל-`vibeTradingService` מלבד שני ה-endpoints האלה.

## כלי כריית אנומליות (נוסף 2026-07-25, הורחב לטבלת הסריקה באותו יום)

הכרייה עצמה היא CLI עצמאי, **לעולם לא רץ אוטומטית** - `server/src/services/research/` (תלות חד-כיוונית: research → קוד קיים; היוצא-מן-הכלל היחיד: `matchSymbols` נקרא מ-`routes/anomalyMatch.js`, ראו למטה). מטרתו לגלות חוקים מהנתונים עצמם (בניגוד לחמש האסטרטגיות ב-`strategies.js`, שכולן חוקים שהובאו מבחוץ ואומתו): סורק שנה אחורה על ~670 מניות NASDAQ בטווח שווי שוק 300M-10B, מחפש ימים עם קפיצה של 12%+ (close-to-close), ובודק שיטתית אילו תנאים ביום שקדם לקפיצה חוזים אותה טוב יותר מהמקרה (`lift` מול base rate, לא רק "מה קדם לקפיצות").

**המגן הכי חשוב:** חלוקה כרונולוגית - גילוי תבניות רק על 8 החודשים הראשונים (in-sample), אימות פעם אחת על 4 החודשים האחרונים (holdout) שלא נגעו בהם בשלב הגילוי. תבנית שלא שורדת holdout נזרקת ומוצגת בדוח כ"נפלה" (לא מוסתרת) - זו העדות המרכזית נגד overfitting. הרצה אמיתית (2026-07-25): 115 תבניות עברו את שלב הגילוי, 101 שרדו holdout, 14 נפלו.

**הרצת הכרייה** (ידנית בלבד): `npm run research:mine --workspace server` (בונה/מרענן `docs/ANOMALY_FINDINGS.md` + `server/src/data/anomalyPatterns.json` - **בניגוד לשאר קבצי ה-data, זה כן ב-git**, ראו למטה) ואז `npm run research:match --workspace server` (CLI, מציג אילו מניות עומדות היום בתבניות ששרדו).

**אינטגרציית טבלת הסריקה** (`GET/POST /api/anomaly-match`, מאחורי `ANOMALY_MATCH_ENABLED`): עמודה בטבלת תוצאות הסריקה שבודקת אוטומטית (לא לחיצה) האם כל אחת מהתוצאות עומדת כרגע בתבנית ששרדה - קריאה נפרדת מ-`/api/analyze`, לא חלק ממנו. **בכוונה, בניגוד ל-Vibe-Trading, נועד לעבוד גם ב-Render** (לכן `anomalyPatterns.json` מחויב ל-git - מתעדכן ידנית כשמריצים מחדש `research:mine` ודוחפים; `researchBars.json` נשאר לא ב-git, לא נחוץ ל-runtime). **רשימה עובדתית בלבד - לא המלצה, לא דירוג** (ראה סעיף 0.4 ב-`SPEC_ANOMALY_MINING.md`). קבצים: `anomalyResearchService.js#matchSymbols`/`#isEnabled`, `routes/anomalyMatch.js`, `client/src/App.jsx` (`AnomalyMatchCell`).

## מוסכמות עבודה בריפו הזה

- טסטים: `node:test` + `node:assert/strict` תחת `server/test/` (`npm test --workspace server`). דפוס נפוץ: `delete require.cache[...]` לטעינה מחדש של מודול + ניקוי env vars ב-setup.
- שינויי UI: להריץ dev server (Claude Browser preview tools) ולבדוק בפועל - כולל לוודא שהמצב "כבוי/ברירת מחדל" של תכונות feature-flagged נשאר זהה בייט-לבייט להתנהגות הקודמת.
- `.env` בשורש הוא ה-source of truth למפתחות מקומיים ומ-gitignore (`git check-ignore -v .env` מאשר). לעולם לא לחשוף את תוכנו (אפילו לא ב-`cat`/הדפסה לטרמינל) - להשתמש ב-Read tool בלבד כשצריך לבדוק מבנה, ולא לצטט ערכי מפתחות בהודעות.
- build: `npm run build` (root) בונה את הלקוח ל-`client/dist`; לנקות אחרי בדיקה מקומית לפי המוסכמה הקיימת בפרויקט.
- Deploy: push ל-`main` -> auto-deploy ב-Render (ראו `docs/DEPLOYMENT.md`).

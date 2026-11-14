# TradeSense — סיכום מערכת מלא (עודכן 14.11.2026)

מסמך מצב לשיחה חדשה. מתאר מה קיים, איך זה עובד, מה הוחלט, מה פתוח, ומה לא לגעת בו. כללי הברזל בראש `CLAUDE.md` תקפים כאן במלואם. החלק של Alpaca מפורט ב-[ALPACA_TRADER.md](ALPACA_TRADER.md).

## 1. מטרה ומצב כללי

מערכת איתותים וביצוע אוטומטי למניות ארה"ב, **בחשבונות דמו בלבד**, עם שתי זרועות מסחר עצמאיות על אותו שרת ואותו אתר (עברית, RTL):

| זרוע | ברוקר | מניות | מצב נכון ל-14.11.2026 |
|---|---|---|---|
| **Colmex/MT4** (שנבנתה עם האח) | Colmex MT4 דמו, חשבון `102992` | 43 מניות ענק ממופות | האתר סורק ומפיק איתותים; ה-MT4 לא היה מחובר בבדיקות האחרונות ("סורק בלבד", לא נשלחות פקודות) |
| **Alpaca** (נבנתה בשיחה הזו) | Alpaca paper, חשבון נייר נפרד | small/mid-cap תנודתיות, מאגר של 150 | פעילה ומסחרית בדמו; כ-13 עסקאות עד 13.11, לא הוכח יתרון |

אתר חי: https://trade.flowsbiz.com. ריפו: https://github.com/haimshafir1984/TradeSense (`main`). **אסור לפגוע בצד של Colmex/MT4 ובמערכות האחרות של המשתמש על אותו שרת (FlowsBiz).**

## 2. תשתית ופריסה (מאז ההעברה מ-Render)

- **שרת:** VPS של Contabo (Ubuntu, 8 vCPU, 24GB), Docker Swarm דרך **Dokploy**. משותף לכ-60 קונטיינרים של המערכת הראשית FlowsBiz (שירותים ששמם מתחיל ב-`client-`, `flowsbiz-admin`, `dokploy`, `dokploy-traefik`): **לא לגעת בהם**.
- **השירות:** `tradesense-tradesense-3pkcvj`, `replica` אחד (חובה: SQLite יחיד), תהליך Node 24 יחיד, מגבלות **CPU 2 ליבות, זיכרון 1.5GiB**. נפח `/data` (בשרת: `/var/lib/tradesense`) מכיל `autopilot.sqlite` (כ-1GB, מצב WAL), `portfolio.json` ו-`backups/`.
- **פריסה:** push ל-`main` ← Dokploy. את ה-`Deploy` מבצע **המשתמש בלבד**. **סדר עדכון `stop-first`** מוגדר ב-Dokploy (`Advanced ← Swarm Settings ← Update Config`) כדי שלא יהיו שני קונטיינרים כותבים על אותו SQLite (`start-first` גרם ל-`database is locked` ולקריסות). בזמן דיפלוי יש ניתוק של כמה שניות עד דקה; עדיף מחוץ לשעות מסחר.
- **בדיקת בריאות:** ב-`Dockerfile` `--interval=30s --timeout=30s --start-period=180s --retries=10` (סלחנית; בעבר נהרג קונטיינר עסוק עם `exit 137`).
- **גיבוי:** `server/scripts/backupDb.js` (גיבוי עקבי, בטוח בזמן ריצה), `deploy/dokploy/backup.sh`. ראו `docs/VPS_MIGRATION*.md`, `docs/DOKPLOY_DEPLOYMENT.md`.
- **ניטור אבחוני:** `server/src/eventLoopMonitor.js` רושם ללוג חסימות event loop (`[loop-lag]`), פעולות SQL/store איטיות (`[slow-op]`) ובקשות איטיות (`[slow-request]`). `LOOP_MONITOR=off` מכבה; `LOOP_MONITOR_SLOW_MS`/`LOOP_MONITOR_REQUEST_MS` מעלים סף (כדי להקטין נפח לוג).

## 3. ארכיטקטורה כללית

- **שרת:** Express + SQLite סינכרוני (`node:sqlite`). הטבלה `records(kind,id,body,metadata)` כאחסון מפתח-ערך ועוד טבלאות יחסיות (המלצות, הערכות, תור בדיקות, דאטהסטים ללמידה). המנועים רצים גם כשהדפדפן סגור.
- **לקוח:** React + Vite, `App.jsx` גדול, לשוניות: מסחר חי, איתותים, תוצאות, כללים והגדרות, **חשבון דמו Alpaca**. כל הפולינג מושהה כשהלשונית לא גלויה (`client/src/pollWhileVisible.js`).
- **אסטרטגיות (`autopilot/strategies.js`)** על נרות 5 דקות **סגורים**: `orb15` (פריצת טווח פתיחה), `orb15_retest`, `gap_pullback`, `vwap_reclaim`, `vwap_pullback`, `momentum_bull_flag`, `reversal5`, `pullback2_v1` (תיקון יומיים במגמה), `breakout20_v1` (פריצת שיא 20 יום). רוב האסטרטגיות דורשות נפח יחסי (1.2–2). היעד תמיד 2R. הכלל "נר אחרון סגור בן פחות מ-7 דקות" פוסל מניות כש"הנר ישן" (`intraday_missing`).
- **זרימת הכניסה (Colmex):** איתות ← קופסה ← חלון איסוף ← ציון (משפחות, איכות, קטליסט) ← סף ← גודל (מינימום 10 מניות) ← `risk.validateSignal` ← תור פקודות ← EA ב-MT4 (polling כל 15 שניות). יציאות: `exitManager` (הפסד יומי, סטופ/יעד, סוף יום). פרטים ב-`CLAUDE.md` ו-`SPEC_V3_*.md`.
- **זרימת הכניסה (Alpaca):** ראו `ALPACA_TRADER.md` (מאגר, סריקה מיושרת, limit IOC, גודל לפי סיכון, יציאות ב-30 שניות, מימוש חלקי, סטופ נגרר).

## 4. מערכת הלמידה (feedback) — מצב ותוכנית

רכיב בצד של Colmex (`autopilot/feedback.js`, `recommendations.js`): כל המלצה/איתות נבדק בתוצאה (`plan`, d0, d1, d3, d5) מנרות, בונים דאטהסט, ומאמנים "מדיניות" שמדרגת איתותים מחדש. **מצב: `shadow`, אינה משפיעה על שום החלטה.** הפעלה אוטומטית ("`active_limited`") אפשרית רק אחרי: ≥100 איתותים מוכרעים פזורים על ≥15 ימי מסחר, כיסוי ≥70%, ניסוי חוזר שהושלם ויתרון בוולידציה (סף הועלה ב-13.11 כדי שלא תופעל על רעש).

מה תוקן (5-9.11): התור היה תקוע (כ-1,000 בדיקות נכשלו שוב ושוב עד 1,500 פעמים וחסמו 85,000 בדיקות חדשות) ← המתנה גדלה, ויתור אחרי ניסיונות, בדיקות חדשות קודם; בניית הדאטהסט (כ-100,000 שורות, 7-70 שניות חסימה) הייתה חוזרת כל 3 דקות ← עכשיו לכל היותר כל 30 דקות ורק מחוץ לשעות מסחר. **אין עדיין למידה אוטומטית ל-Alpaca**; יש לה תיוג בצל שמצטבר (ראו `ALPACA_TRADER.md` §8).

## 5. אירועים עיקריים ולקחים (28.10–13.11.2026)

1. **התראות push הפסיקו (Render):** אחסון/דיסק, ולכן הוחלט להעביר ל-VPS. בוצע (Dokploy, Contabo).
2. **502 ו-event loop חסום (20-70 שניות):** כמה גורמים שנמצאו עם המנטר: שאילתת הדשבורד בלי אינדקס (62 שניות; נוסף `idx_recommendation_jobs_recommendation`), בניית דאטהסט חוזרת, בדיקת בריאות שהרגה קונטיינר, **שני קונטיינרים על אותו SQLite** (תיקון: `stop-first` + עדכוני סטטוס שלא מפילים תהליך).
3. **Alpaca:** OOM בבנייה (3.11), באג NaN, rvol שגוי (IEX מול SIP), סריקה לא מיושרת, **באג חשיפה (10.11)**, סגירת סוף יום אחרי הסגירה. פירוט ב-`ALPACA_TRADER.md` §9.
4. **מחקר אסטרטגיות (v4/v5/v6):** כל התוצאות שליליות (`V3_STRATEGY_RESEARCH_RESULTS.md`, `V6_TREND_TEMPLATE_VCP_RESULTS.md`). לא הוכח יתרון.

## 6. תוכניות ורעיונות פתוחים (לפי עדיפות; **לא יושמו בלי אישור**)

1. **ניתוח תיוג הבצל של Alpaca** כשיצטברו מאות איתותים: אילו אסטרטגיות/תנאים עובדים, השוואת יציאות (2R קבוע מול חלקי מול נגרר), MFE/MAE. אחר כך כיבוי אוטומטי של אסטרטגיה מפסידה אחרי מדגם מינימלי ובדיקה על חלון נע.
2. **מסחר לטווח קצר (עד 5 ימים), חצי מהתיק:** נדחה. קודם מעקב בצל על נרות יומיים (אפשר גם בדיקה היסטורית), ורק אחר כך הקצאה קטנה. דורש ארכיטקטורה: חצי נפרד לכל סוג, החזקה ללילה (פערי מחיר, דוחות), יציאות לפי נרות יומיים.
3. **שדרוג נתוני SIP בזמן אמת** (Alpaca Algo Trader Plus, כ-99$ לחודש): פותר את `intraday_missing` (כ-45 מניות לסריקה). לא כדאי לפני שיש הוכחת יתרון.
4. **שורט:** אפשרי ב-Alpaca (חשבון margin, מניות `shortable`/`easy_to_borrow`), אבל מניות קטנות לרוב "קשות להשאלה" והסיכון בלתי מוגבל. לא עכשיו.
5. **הורדת עומס CPU** (ראו `CPU_ANALYSIS_2026-11-11.md`): `PRAGMA synchronous=NORMAL` וכתיבות בטרנזקציות, דילוג על בניית דאטהסט כשאין נתונים חדשים, צמצום לוגים. ממתין לאישור.
6. **תיקונים שנשארו:** כ-31 מניות לסריקה בלי נתונים יומיים (`daily_missing`), חיבור `hasNews` לשתי אסטרטגיות, דחיסת SQLite (כ-1GB).
7. **סגירה ידנית של פוזיציה בלשונית Alpaca:** הוחלט לא להוסיף בשלב הלמידה (מזהם את הנתונים).

## 7. בעיות ידועות

- **10 טסטים נכשלים בסביבת הפיתוח** (autopilot, decisionFeed, v3flex, שירות הלקוח, system pause), אינם קשורים לשינויים אחרונים. טסטים דורשים Node 24.
- נתוני IEX בלבד: מניות דלילות נפסלות. אין לוח חגים. אין שורט.
- **צד Colmex:** ה-EA מחובר רק כשהמחשב עם MT4 פעיל (בדיקות 24/7 מרחוק לא הוכרעו); גודל פוזיציה מינימלי 10 מניות; ExecutionToken מודפס ביומן ה-MT4 (הצעת מיסוך ללא תשובה); `GET /api/execution/decisions` ו-`/outcomes` תוקנו אך דורשים אימות בפרודקשן.

## 8. תפעול ואבחון (קריאה בלבד, בשרת)

```bash
docker service ps tradesense-tradesense-3pkcvj --no-trunc | head
```

```bash
docker service logs --since 1h tradesense-tradesense-3pkcvj 2>&1 | grep -E "\[loop-lag\]|\[slow-request\]" | cut -c1-300
```

האבחון של סריקות Alpaca ו"למה לא נקנה": ראו `ALPACA_TRADER.md` §11. שחזור/גיבוי: `docs/VPS_MIGRATION.md`. איפוס קוד כניסה (הקוד נשמר רק כ-hash): `AUTOPILOT_CODE_RESET` (ו-`AUTOPILOT_CODE_RESET_USER`) ואז פריסה. כפתור "השהה מערכת" (`POST /api/autopilot/system`) משהה את המנוע הראשי.

## 9. אינדקס מסמכים (בסדר קריאה מומלץ)

1. `CLAUDE.md` — כללי ברזל והעדפות עבודה (חובה ראשון).
2. **המסמך הזה.**
3. `ALPACA_TRADER.md` — הזרוע של Alpaca.
4. `DOKPLOY_DEPLOYMENT.md`, `VPS_MIGRATION.md`, `VPS_MIGRATION_HANDOFF.md` — תשתית והעברה.
5. `CODEX_502_INVESTIGATION.md`, `CPU_ANALYSIS_2026-11-11.md` — תחקיר ה-502 והניתוח של צריכת ה-CPU.
6. `SPEC_V3_AUTOPILOT.md`, `SPEC_V3_FLEXIBLE_FILLS_AND_STRATEGIES.md`, `SPEC_V3_SCAN_COVERAGE.md` — אסטרטגיות וסריקה (Colmex).
7. `SPEC_FEEDBACK_LEARNING_*`, `SPEC_RECOMMENDATION_*`, `RECOMMENDATION_REVIEW_VALIDATION.md` — מערכת הלמידה.
8. `V3_STRATEGY_RESEARCH_RESULTS.md`, `V6_TREND_TEMPLATE_VCP_RESULTS.md`, `BACKTEST_*`, `ANOMALY_FINDINGS.md` — מחקר.
9. ישן/היסטוריה: `SPEC_V2_*`, `BACKFILL_FINDINGS.md` (הקוד ב-`pipeline/`, `playbooks/`, `ledger/` אינו במסלול הפעיל).

## 10. נתונים ופרטיות

מצב משתמש (קופסאות, יומן כניסות, הגדרות) לפי פרופיל משתמש (המזהה נשמר בדפדפן, הקוד נשמר כ-hash); פקודות ביצוע, יציאות ותוצאות של Colmex גלובליים לחשבון; כל מצב Alpaca גלובלי (חשבון אחד). מפתחות רק ב-env בשרת. **לא להדפיס `.env` או מפתחות בצ'אט או בלוגים.**

# CLAUDE.md

מסמך התמצאות לתחילת שיחה חדשה של Claude Code בפרויקט הזה. עודכן ב-14.11.2026. המסמך המלא והמפורט: [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) — לקרוא אותו לפני כל שינוי בלוגיקת ביצוע או סיכון. החלק של Alpaca: [docs/ALPACA_TRADER.md](docs/ALPACA_TRADER.md).

## כללי ברזל (הוראות המשתמש, מחייבות)

- **אסור** לבצע מסחר בחשבון אמיתי, לפרוס את המערכת מרחוק (`Deploy` ב-Dokploy רק על ידי המשתמש), או לפגוע באפליקציה הקיימת של האח ובמערכות האחרות על אותו שרת (FlowsBiz: שירותים ששמם מתחיל ב-`client-`, `flowsbiz-admin`, `dokploy`, `dokploy-traefik`).
- **אין לשנות הגדרות מסחר** (ערכי כניסה, סיכון, גודל פוזיציה, מצב ביצוע, בשתי הזרועות) **ולא להפעיל ביצוע פקודות** בלי אישור מפורש של המשתמש באותה שיחה. גם שינוי התנהגות של כניסה/יציאה דורש אישור מפורש.
- המערכת רצה **בדמו בלבד**: Colmex MT4 דמו `102992`, ו-Alpaca paper (`broker.js` מקובע ל-`paper-api.alpaca.markets`). הקוד דוחה כל חשבון שאינו מזוהה כדמו.
- **`git push`:** מ-13.11.2026 המשתמש אישר במפורש לדחוף ל-`main` **אחרי שינוי שעבר בדיקות** (טסטים עוברים, מלבד 10 הכשלים הידועים). אחרי הדחיפה לומר למשתמש שאפשר לעשות דיפלוי. לא לדחוף שינוי שלא נבדק. את ה-`Deploy` עושה המשתמש.
- לא לחשוף ערכי `.env` / מפתחות / `EXECUTION_AGENT_TOKEN` / סיסמאות בצ'אט, בלוגים או במסמכים. לא לכתוב כתובת IP של השרת במסמכים.

## העדפות תקשורת עם המשתמש (חיים)

- עברית, בשפה פשוטה. כל מונח, פקודה או הגדרה באנגלית — **בשורה נפרדת משלה** (ה-RTL מבלבל אחרת). פקודות לשרת: כל אחת בבלוק קוד משלה, בלי שורה מעורבבת.
- שאלה מהצורה "אתה יכול X?" או "האם כדאי?" — קודם תשובה (כן/לא/המלצה), ולחכות ל"תעשה". לא להתחיל לבצע לבד.
- תשובות קצרות ומעשיות. אחרי שינוי קוד: מה נעשה, האם נדחף, ומה המשתמש צריך לעשות (לרוב: דיפלוי ב-Dokploy, ואז `Ctrl + Shift + R`; במחשב נייד `Ctrl + F5` מכבה תאורה).
- להסביר מונחי מסחר כשצריך (R, break-even, slippage). המשתמש לא מתכנת; חשוב לו שהמערכת תלמד את האסטרטגיות ולכן לא להתערב ידנית בעסקאות.
- כשמשהו לא ברור: להציג הוכחה (מספרים, מדידה) ולא השערה; להודות בטעות אם התברר שהייתה.

## מה המערכת

TradeSense מייצרת איתותי מניות ארה"ב ומריצה אותם **אוטומטית** בשתי זרועות עצמאיות על אותו שרת ואתר (React בעברית RTL):

1. **Colmex/MT4** (נבנתה עם האח): סורק + אסטרטגיות, פקודות דרך EA ב-MT4. 43 מניות ענק. מצב נוכחי: איתותים נוצרים; ה-MT4 מחובר רק כשהמחשב עם ה-EA פעיל.
2. **Alpaca** (חשבון נייר, small/mid-cap): מנוע נפרד ב-`server/src/alpaca-trader/`, לשונית "חשבון דמו Alpaca". פרטים מלאים ב-[docs/ALPACA_TRADER.md](docs/ALPACA_TRADER.md).

- אתר חי: https://trade.flowsbiz.com. ריפו: https://github.com/haimshafir1984/TradeSense (`main`).
- **תשתית:** VPS של Contabo, Docker Swarm דרך Dokploy. שירות `tradesense-tradesense-3pkcvj`, `replica` אחד, SQLite ב-`/data/autopilot.sqlite` (כ-1GB, WAL), מגבלות CPU 2 / זיכרון 1.5GiB. **סדר עדכון `stop-first`** מוגדר (שני קונטיינרים על אותו SQLite גרמו לקריסות). Dokploy עושה deploy מ-`main`.
- סביבות עבודה של המשתמש: `C:\Users\haim\Projects\TradeSense` (המחשב הנוכחי) ובעבר `C:\Users\moshe\...` (לשמור סנכרון אם קיים).

## זרימה מקצה לקצה — Colmex

1. `server/src/autopilot/engine.js` — tick כל 30 שניות; סריקה כל `AUTOPILOT_SCAN_INTERVAL_MS` (ברירת מחדל 5 דקות). האסטרטגיות (`strategies.js`) עובדות על נרות 5 דקות **סגורים**; נר אחרון בן יותר מ-7 דקות ← `intraday_missing`.
2. איתות ← `execution/entryDecision.js`: קופסה לכל `יום:מניה`, חלון איסוף (`windowMin`), ציון (משפחות + איכות + קטליסט). החלטה `entered` / `skipped` ביומן `entryLog`.
3. גודל פוזיציה; **מינימום 10 מניות** (מגבלת Colmex) ← `size_too_small`.
4. `execution/risk.js` `validateSignal`: דמו בלבד, נתוני MT4 עדכניים, בסיס הפסד יומי, **מניה לא תפוסה** (`symbol_busy`) על כל פקודות חשבון הברוקר (קולקציה גלובלית `executionOrder`).
5. `execution/bridge.js` ממפה ticker לסימול Colmex (`COLMEX_US` + `EXECUTION_SYMBOL_MAP_JSON`, סיומת `#`) ← תור (`orders.js`).
6. ה-EA (`mt4/TradeSenseExecutionEA.mq4`) עושה polling (HTTPS, בלי פורט), מבצע, ומדווח `heartbeat` + פוזיציות + עסקאות סגורות.
7. `execution/exitManager.js`: הפסד יומי, סטופ, מדרגות רווח, סוף יום ← `exitLog`; `execution/outcomes.js` ספר תוצאות; `decisionFeed.js` ← `GET /api/execution/decisions`.
8. רווח/הפסד יומי: `dayPnl` = שווי חשבון פחות שווי בפתיחת יום ניו יורק. התראות push: `pushOnlyBought`.

## מבנה קוד

```
server/src/
  autopilot/      engine, strategies, store (SQLite, kind + putUser/listUser), market, history, notifications,
                  feedback (למידה), recommendations (תור בדיקות), users, settings, ...
  execution/      צד Colmex: autonomy, bridge, entryDecision, risk, exitManager, outcomes, decisionFeed, ...
  alpaca-trader/  צד Alpaca: universe, scan, entry, risk, exit, engine, notify, trades, history, shadow, settings, broker
  routes/         autopilot.js, execution.js, alpacaTrader.js (+ ישנים)
  eventLoopMonitor.js   ניטור אבחוני (LOOP_MONITOR=off מכבה)
  pipeline/ playbooks/ ledger/ providers/ services/ risk/   ← שרידי v2, לא במסלול הפעיל
client/src/      App.jsx (ענק), AlpacaTraderPanel.jsx, AlpacaPanelParts.jsx, pollWhileVisible.js, EntryPanel, RiskPanel, ...
mt4/             EA + mqh + כלי אבחון
deploy/          dokploy (backup.sh, switch.sh), vps, mt4-wine
server/scripts/backupDb.js   גיבוי עקבי של SQLite
```

## אתר: לשוניות

`מסחר חי` (Colmex), `איתותים`, `תוצאות`, `כללים והגדרות`, ו-**`חשבון דמו Alpaca`** (סדר: מצב חשבון, פוזיציות, ממתינות, מה נקנה, ביצועים והיסטוריה, מקופלים: עסקאות/יציאות/סריקות/איתותי בצל, ובתחתית הגדרות).

## משתני סביבה חשובים (שרת)

Colmex: `EXECUTION_AUTONOMY_ENABLED`, `EXECUTION_QUEUE_ENABLED`, `EXECUTION_AGENT_TOKEN`, `EXECUTION_BROKER_ACCOUNT_ID`, `EXECUTION_SYMBOL_MAP_JSON`, `AUTOPILOT_BROKER_ONLY`, `AUTOPILOT_SCAN_INTERVAL_MS`. כללי: `AUTOPILOT_DB_PATH`, `FINNHUB_API_KEY`, `ALPACA_API_KEY_ID/SECRET` (נתונים), `CLIENT_ORIGIN`, `AUTOPILOT_DISABLED`, `SENTIMENT_COLLECT`, `AUTOPILOT_CODE_RESET(_USER)`. Alpaca: `ALPACA_TRADER_ENABLED`, `ALPACA_TRADER_API_KEY_ID/SECRET_KEY` (חשבון Paper נפרד), `ALPACA_TRADER_*` (מרווחים, מאגר, שומר זיכרון). ניטור: `LOOP_MONITOR`, `LOOP_MONITOR_SLOW_MS`. למידה: `FEEDBACK_REBUILD_MIN_MS`. **להגדיר משתנה פעם אחת בלבד ב-Dokploy** (כפילויות כבר גרמו לשינוי שלא נקלט).

## מוסכמות והכרת מלכודות

- **SQLite כותב יחיד.** `node:sqlite` סינכרוני: כל קריאה/כתיבה חוסמת את ה-event loop, וכל כתיבה בנפרד היא fsync. עבודות כבדות (בניית דאטהסט, שאילתות בלי אינדקס) הפילו את האתר (502). לפני שאילתה חדשה בדקו `EXPLAIN QUERY PLAN` על עותק של המסד.
- **שני קונטיינרים על אותו קובץ SQLite** = `database is locked`. לכן `replica` אחד ו-`stop-first`. עדכוני סטטוס של המנועים עטופים כדי שנעילה לא תפיל את התהליך.
- טסטים דורשים Node 24 (`node:sqlite`). `node:test` ב-`server/test/` (`node --test test/*.test.js` מתוך `server/`). **10 טסטים נכשלים בסביבת הפיתוח** (autopilot, decisionFeed, v3flex, שירות הלקוח, system pause), ללא קשר לשינויים אחרונים. טסטים חדשים: `AUTOPILOT_DB_PATH` זמני ומזהים ייחודיים; בטסטים של Alpaca קוראים ל-`setup()` שמנקה מטמון מודולים.
- הלקוח לא נבנה מקומית. בדיקת תחביר: `npx esbuild client/src/AlpacaTraderPanel.jsx --loader:.jsx=jsx`. אפשר לבדוק רינדור ב-Node עם `react-dom/server` (ראו הסשן שבנה את הלשונית) ובדפדפן על קובץ HTML סטטי.
- שעון: `nyTimestamp()` מחזיר **מספר** (מילישניות), לא מחרוזת (`Date.parse` עליו נותן `NaN`).
- Alpaca: נתוני IEX בלבד (חינמי); `rvol` חייב להשוות IEX מול IEX; הוראות מחוץ לשעות 9:30–16:00 ניו יורק לא מתבצעות אלא ממתינות לפתיחה.
- `git` על Windows משאיר לפעמים קבצי `.lock`/`tmp_obj`; commit דורש `-c user.name=... -c user.email=...`; סיומות שורה LF/CRLF גורמות לאזהרות בלבד.
- בסיס הפסד יומי: Colmex `riskProfile.ensureDayBase`; Alpaca `alpaca-trader/risk.js`.
- ה-EA: ללא `ExecutionToken` ו-`BrokerAccountId` ב-Inputs הוא כותב "execution disabled". `EnableExecution=false` כברירת מחדל. WebRequest דורש כתובת ב-`Tools > Options > Expert Advisors`.
- שרת מחזיר לפעמים `502` (Traefik); הלקוח מנסה שוב GET אחד ומציג הודעה קריאה.

## מסמכים (בסדר קריאה מומלץ)

1. [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) — תמונה מלאה: מצב, תשתית, למידה, אירועים ולקחים, תוכניות, בעיות.
2. [docs/ALPACA_TRADER.md](docs/ALPACA_TRADER.md) — הזרוע של Alpaca.
3. [docs/DOKPLOY_DEPLOYMENT.md](docs/DOKPLOY_DEPLOYMENT.md), [docs/VPS_MIGRATION.md](docs/VPS_MIGRATION.md), [docs/VPS_MIGRATION_HANDOFF.md](docs/VPS_MIGRATION_HANDOFF.md) — פריסה והעברה.
4. [docs/CODEX_502_INVESTIGATION.md](docs/CODEX_502_INVESTIGATION.md), [docs/CPU_ANALYSIS_2026-11-11.md](docs/CPU_ANALYSIS_2026-11-11.md) — תחקיר ביצועים.
5. [docs/SPEC_V3_AUTOPILOT.md](docs/SPEC_V3_AUTOPILOT.md), [docs/SPEC_V3_FLEXIBLE_FILLS_AND_STRATEGIES.md](docs/SPEC_V3_FLEXIBLE_FILLS_AND_STRATEGIES.md), [docs/SPEC_V3_SCAN_COVERAGE.md](docs/SPEC_V3_SCAN_COVERAGE.md) — אסטרטגיות וסריקה (Colmex).
6. מחקר: `V3_STRATEGY_RESEARCH_RESULTS.md`, `V6_TREND_TEMPLATE_VCP_RESULTS.md` (כל התוצאות שליליות). v2 (`SPEC_V2_ARCHITECTURE.md` וכו') — היסטוריה בלבד.

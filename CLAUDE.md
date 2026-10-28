# CLAUDE.md

מסמך התמצאות לתחילת שיחה חדשה של Claude Code בפרויקט הזה. עודכן ב-28.10.2026. המסמך המלא והמפורט: [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) — לקרוא אותו לפני כל שינוי בלוגיקת ביצוע או סיכון.

## כללי ברזל (הוראות המשתמש, מחייבות)

- **אסור** לבצע מסחר בחשבון אמיתי, לפרוס את המערכת מרחוק, או לפגוע באפליקציה הקיימת של האח.
- **אין לשנות הגדרות מסחר** (ערכי כניסה, סיכון, גודל פוזיציה, מצב ביצוע) **ולא להפעיל ביצוע פקודות** בלי אישור מפורש של המשתמש באותה שיחה.
- המערכת רצה **בדמו בלבד**: חשבון Colmex MT4 דמו `102992`. הקוד דוחה כל חשבון שאינו מזוהה כדמו.
- לא לבצע `git push` ולא לפרוס: המשתמש עושה בעצמו `Sync Changes` ב-VS Code, ו-Dokploy עושה deploy אוטומטי מ-`main`. מותר commit מקומי.
- לא לחשוף ערכי `.env` / מפתחות / `EXECUTION_AGENT_TOKEN` בצ'אט או בלוגים.

## העדפות תקשורת עם המשתמש (חיים)

- עברית. כל מונח, פקודה או הגדרה באנגלית — **בשורה נפרדת משלה** (ה-RTL מבלבל אחרת), במיוחד בהוראות צעד-אחר-צעד.
- שאלה מהצורה "אתה יכול X?" — קודם תשובה כן/לא, ולחכות ל"תעשה". לא להתחיל לבצע לבד.
- תשובות קצרות ומעשיות. אחרי שינוי קוד: לומר מה עשה, ומה המשתמש צריך לעשות (`Sync Changes`, לחכות ל-`Done` ב-Dokploy, `Ctrl+F5`).

## מה המערכת

TradeSense מייצרת איתותי מניות ארה"ב (סורק + 4 אסטרטגיות), ומריצה אותם **אוטומטית** כפקודות דרך MT4 של Colmex בחשבון דמו. אתר React בעברית RTL מציג מצב, החלטות ותוצאות. מאוחדת עם מנוע האיתותים של האח (אסור לפגוע בו).

- אתר חי: https://trade.flowsbiz.com (Dokploy, container יחיד, replica אחד, SQLite ב-`/data`).
- ריפו: https://github.com/haimshafir1984/TradeSense (ענף `main`).
- סביבות עבודה אצל המשתמש: `C:\Users\moshe\Projects\m.s.trader\_TradeSense_remote` (הריפו העיקרי) ו-`...\TradeSense-main\TradeSense-main` (עותק משוקף; לשמור סנכרון).

## זרימה מקצה לקצה

1. `server/src/autopilot/engine.js` — tick כל 30 שניות; סריקה כל `AUTOPILOT_SCAN_INTERVAL_MS` (ברירת מחדל 5 דקות, מינימום 60 שניות). האסטרטגיות (`strategies.js`) עובדות על נרות 5 דקות **סגורים**.
2. איתות נרשם ← `execution/entryDecision.js`: "קופסה" לכל `יום:מניה` למשתמש. חלון איסוף (`windowMin`, כרגע 3 דקות), ציון משפחות + איכות + קטליסט (`catalystCache.js`). החלטה: `entered` / `skipped` (עם `reason`) ביומן `entryLog`.
3. גודל פוזיציה לפי תקציב/סיכון/חשיפה; **מינימום 10 מניות** (מגבלת Colmex). מתחת ← `size_too_small`.
4. `execution/risk.js` `validateSignal`: דמו בלבד, נתוני MT4 עדכניים, בסיס הפסד יומי, מגבלות, **מניה לא תפוסה** (`symbol_busy`) — נבדק על כל הפקודות של חשבון הברוקר (קולקציה גלובלית `executionOrder`), לא רק של המשתמש.
5. `execution/bridge.js` ממפה ticker לסימול Colmex (מילון `COLMEX_US` + `EXECUTION_SYMBOL_MAP_JSON`; סיומת ברוקר `#`) ומכניס פקודה לתור (`orders.js`).
6. ה-EA ב-MT4 (`mt4/TradeSenseExecutionEA.mq4`) עושה polling לשרת (HTTPS, בלי פורט בכתובת), מבצע, ומדווח `heartbeat` + פוזיציות + עסקאות סגורות (`TradeSensePositions.mqh`).
7. `execution/exitManager.js` מנהל יציאות (הפסד יומי, סטופ, מימוש רווח במדרגות, סגירת סוף יום) ורושם ל-`exitLog`. `execution/outcomes.js` — ספר תוצאות לפי ticket.
8. `execution/decisionFeed.js` ממזג כניסות ויציאות ← `GET /api/execution/decisions`.
9. רווח/הפסד יומי: `positions.current()` מחזיר `dayPnl` (שווי חשבון פחות שווי בפתיחת יום ניו יורק). התראות push: הגדרה `pushOnlyBought` (רק כניסות).

## מבנה קוד

```
server/src/
  autopilot/   engine, strategies, store (SQLite, kind + putUser/listUser), market, notifications,
               premarketLog, sentimentLog, users, settings
  execution/   autonomy, bridge, entryDecision, entryProfile, risk, riskProfile, positions, orders,
               exitManager, exitLog, outcomes, decisionFeed, catalystCache, closeRequests, pnlHistory
  routes/      autopilot.js, execution.js (+ ישנים: candidates, ledger, playbooks, portfolio, backtest)
  pipeline/ playbooks/ ledger/ providers/ services/ risk/   ← שרידי v2, לא במסלול הפעיל
client/src/    App.jsx (ענק; מצב `tab`), ControlTerminal (בתוך App.jsx), EntryPanel, RiskPanel, PnlPanel,
               DecisionLog, styles.css
mt4/           EA + mqh + כלי אבחון WebRequest + tools/ (MfeCheck, port80-forwarder)
deploy/        dokploy, vps, mt4-wine (Docker+Wine, לא נבדק)
```

## אתר: ארבע לשוניות

`מסחר חי` (ControlTerminal + איתותים והחלטות + פוזיציות MT4 + בקשות סגירה + ארכיון ידני מתקפל), `איתותים` (הזדמנויות היום), `תוצאות` (תת-לשוניות: רווח והפסד | היסטוריה ומעקב), `כללים והגדרות` (תת-לשוניות: כניסה | סיכונים ויציאות | סורק ואסטרטגיות | יומן פעילות). הסרגל העליון (`StatusRibbon`) מציג סורק, בוט, חיבור MT4, מצב חשבון, יתרה, רווח/הפסד היום ורווח פתוח.

## משתני סביבה חשובים (שרת)

`EXECUTION_AUTONOMY_ENABLED`, `EXECUTION_QUEUE_ENABLED`, `EXECUTION_AGENT_TOKEN`, `EXECUTION_BROKER_ACCOUNT_ID`, `EXECUTION_SYMBOL_MAP_JSON`, `AUTOPILOT_BROKER_ONLY` (מגביל ל-43 מניות ממופות), `AUTOPILOT_SCAN_INTERVAL_MS`, `AUTOPILOT_DB_PATH`, `FINNHUB_API_KEY` (קטליסט), `ALPACA_*`, `SENTIMENT_COLLECT`, `CLIENT_ORIGIN`, `AUTOPILOT_DISABLED`.

## מוסכמות והכרת מלכודות

- טסטים דורשים Node 24 (`node:sqlite`); `node` ברירת המחדל במחשב של המשתמש הוא 20. סוג הרשומה של יומן הכניסות הוא `entryDecision` (ב-`decisionFeed.js` וב-`outcomes.js` חייבים להתאים).
- טסטים: `node:test` ב-`server/test/` (`node --test test/*.test.js` מתוך `server/`). **ידוע:** כ-6 טסטים נכשלים בסביבת הפיתוח (autopilot, decisionFeed — נתונים נשארים בין הרצות, v3flex, שירות הקליינט, system pause) ללא קשר לשינויים אחרונים; כתבו טסטים חדשים עם `AUTOPILOT_DB_PATH` זמני ומזהים ייחודיים.
- הלקוח לא נבנה מקומית: לבדיקת תחביר `npx esbuild client/src/App.jsx --loader:.jsx=jsx`.
- סטייט משתמש: `store.putUser/listUser` (kind `user:<id>:<kind>`); פקודות ביצוע וגם יומני יציאה/תוצאות — **גלובליים**.
- `git` על תיקיית ה-Windows המחוברת משאיר קבצי `.lock` ו-`tmp_obj` (אי אפשר למחוק): להזיז ל-`.git/stale-*`. commit דורש `-c user.name=... -c user.email=...`.
- בסיס הפסד יומי נקבע ב-`riskProfile.ensureDayBase`; מ-27.10 גם אוטומטית בניסיון כניסה ראשון של יום כשהמסחר העצמאי פעיל.
- ה-EA: ללא `ExecutionToken` ו-`BrokerAccountId` ב-Inputs הוא כותב "execution disabled". `EnableExecution=false` כברירת מחדל. WebRequest דורש כתובת ב-`Tools > Options > Expert Advisors`.
- שרת מחזיר לפעמים `502` (Traefik); הלקוח מנסה שוב GET אחד ומציג הודעה קריאה.

## מסמכים

- [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) — תמונה מלאה של המצב, החלטות, בעיות פתוחות ורעיונות.
- [docs/SPEC_V3_AUTOPILOT.md](docs/SPEC_V3_AUTOPILOT.md), [docs/SPEC_V3_FLEXIBLE_FILLS_AND_STRATEGIES.md](docs/SPEC_V3_FLEXIBLE_FILLS_AND_STRATEGIES.md), [docs/SPEC_V3_SCAN_COVERAGE.md](docs/SPEC_V3_SCAN_COVERAGE.md) — אסטרטגיות וסריקה.
- [docs/DOKPLOY_DEPLOYMENT.md](docs/DOKPLOY_DEPLOYMENT.md), [deploy/mt4-wine/](deploy/mt4-wine/) — פריסה והרצת MT4 על שרת.
- v2 (`SPEC_V2_ARCHITECTURE.md`, `BACKFILL_FINDINGS.md` וכו') — היסטוריה בלבד; הקוד ב-`pipeline/ playbooks/ ledger/` אינו במסלול הפעיל.

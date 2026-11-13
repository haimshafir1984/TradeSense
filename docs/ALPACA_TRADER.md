# חשבון דמו Alpaca — מסמך התמצאות

נוסף 2026-11-03. זרוע מסחר שנייה, **עצמאית לגמרי** מהצד של Colmex/MT4: אחסון נפרד, סיכון נפרד, ברוקר נפרד. שום קובץ תחת `autopilot/engine.js` או `execution/` לא השתנה כדי לבנות את זה.

## למה זה קיים

הסורק הראשי מוגבל כיום ל-43 מניות ענק דרך `AUTOPILOT_BROKER_ONLY`/`COLMEX_US` — זו מגבלת הברוקר (Colmex), לא מגבלת אסטרטגיה. המטרה כאן: לסחור (בחשבון נייר, Alpaca) על מניות small/mid-cap תנודתיות יותר, ברף סיכון גבוה יותר, בלי לגעת בברוקר/EA הקיימים.

## ארכיטקטורה

```
server/src/alpaca-trader/
  settings.js   פרופיל עריך (סיכון/סף/אסטרטגיות), kind="alpacaTrader"
  broker.js     לקוח Alpaca Trading API, מקובע ל-paper-api.alpaca.markets בלבד
  universe.js   מאגר עצמאי (סף מחיר/נזילות שונה, בלי מילון סימולים)
  scan.js       מחזור סריקה: history.ensureDailyFeatures/ensureIntradayBars (משותף, קריאה בלבד) + strategies.evaluateDetailed
  entry.js      קופסת החלטה/ניקוד/גודל — משתמש ב-execution/entryDecision.score()/size() (פונקציות טהורות, משותפות)
  risk.js       בסיס הפסד יומי + בדיקת חשיפה/תפוסה, מהחשבון של Alpaca (לא MT4)
  exit.js       סטופ/יעד/הפסד יומי/סוף יום — סוגר דרך Alpaca
  engine.js     טיימר עצמאי (ALPACA_TRADER_SCAN_INTERVAL_MS, ברירת מחדל 5 דק')
server/src/routes/alpacaTrader.js   /api/alpaca-trader/status + /settings
client/src/AlpacaTraderPanel.jsx    לשונית "חשבון דמו Alpaca"
```

נקודות השקה היחידות לקוד הקיים: `index.js` (שורת הפעלה נוספת, try/catch נפרד), `app.js` (mount נוסף), `autopilot/strategies.js` ו-`autopilot/history.js` (קריאה בלבד, אותן פונקציות ששני הצדדים חולקים).

## משתני סביבה

| משתנה | ברירת מחדל | הערה |
|---|---|---|
| `ALPACA_TRADER_ENABLED` | לא מוגדר (כבוי) | המנוע כולו לא עולה בלעדיו |
| `ALPACA_TRADER_API_KEY_ID` | — | חשבון **Paper** בלבד ב-Alpaca, נפרד מהמפתח הקיים לנתונים |
| `ALPACA_TRADER_API_SECRET_KEY` | — | |
| `ALPACA_TRADER_SCAN_INTERVAL_MS` | 300000 (5 דק') | |
| `ALPACA_TRADER_UNIVERSE_MAX` | 400 | מספר מניות מרבי במאגר |

`broker.js` מקובע בקוד לכתובת `paper-api.alpaca.markets` — לא ניתן לשינוי דרך env, בכוונה (אותו עקרון כמו הבדיקה "דמו בלבד" בצד MT4).

## הגדרות סיכון (עריכות מהממשק, לא מהקוד)

סוכם עם המשתמש 2026-11-03: `perTradeMinPct 30 / perTradeMaxPct 50`, `totalExposurePct 60`, `maxRiskPct 4`, `dailyLossPct 7`, `minPrice $3`, `minAdv20 $3M`, `minShares 1` (אין מגבלת לוט של Colmex כאן).

## מה לא נכלל ב-v1

- **`gap_pullback` ו-`momentum_bull_flag`** דורשות `hasNews` (אות חדשות/ללא חדשות) שלא חובר כאן. מודרות מרשימת האסטרטגיות כברירת מחדל.
- **נפח יחסי (rvol)** הוא פרוקסי פשוט (נפח מצטבר היום מול ממוצע 20 יום, לפי חלק מהזמן שעבר) — לא הגרסה המדויקת מבוססת-לוח שהמנוע הראשי משתמש בה.
- **אין לוח חגים/ימים מקוצרים** — יום לא-מסחרי פשוט מניב סריקה ריקה.

## תקלה בפרודקשן ותיקון (2026-11-03)

מיד אחרי ההפעלה הראשונה, הקונטיינר נכנס ללולאת קריסה (`exit 137` = SIGKILL, חריגת זיכרון). הסיבה: בניית המאגר של המנוע הזה (כל NASDAQ+NYSE, עד 400 מניות בבאצ'ים) רצה בדיוק באותו רגע כמו הבנייה היומית של המנוע הראשי, בתוך אותה תקרת 1.5GB שהוגדרה ב-Docker. מנגנון הבלימה הקיים (`memoryDiagnostics.js`) כויל לשרת ישן של 512MB ולא מספיק כאן.

תיקון (לא נוגע ב-`memoryDiagnostics.js` המשותף, כדי לא להשפיע על הצד השני):
- `ALPACA_TRADER_UNIVERSE_MAX` ירד מ-400 ל-150 כברירת מחדל.
- שומר זיכרון עצמאי ב-`universe.js`/`scan.js` (`ALPACA_TRADER_MEMORY_GUARD_MB`, ברירת מחדל 900): עוצר את הבנייה מוקדם אם ה-RSS גבוה מדי, במקום לתת ל-Docker להרוג את כל הקונטיינר.
- `ALPACA_TRADER_STARTUP_DELAY_MS` (ברירת מחדל 180000 = 3 דקות): הטיק הראשון של המנוע הזה מתעכב אחרי עלייה, כדי לא להתנגש עם הבאסט הראשוני של המנוע הראשי.

## בדיקות

`server/test/alpacaTrader.test.js` — 7 בדיקות (settings, risk/day-base/breach-latch, entry scoring+sizing+lock, exit stop/breach). רצות עם `broker.js` מדומה (ללא קריאות רשת אמיתיות). `node --test test/*.test.js` מתוך `server/`.

## עדכונים מ-13.11.2026

- **כניסה בהוראת limit (IOC):** הוראת קנייה נשלחת כ-limit במחיר האיתות + `maxSlippagePct` (ברירת מחדל 0.75%) והיא מתבטלת מיד אם המחיר כבר ברח. הסיבה ביומן ההחלטות: `price_too_far`. אפשר לכבות (`limitEntryEnabled`) וחוזרים להוראת שוק.
- **גודל פוזיציה לפי סיכון (`sizingMode: "risk"`):** מסכנים `riskPerTradePct` (0.75%) מהתיק לעסקה, עם תקרת `maxPositionPct` (15%) לפוזיציה בודדת ו-`maxOpenPositions` (5) פוזיציות פתוחות. השיטה הישנה (תקציב לפי ציון) זמינה כ-`"budget"`.
- **תיוג בצל (`shadow.js`):** כל איתות שהסורק מוצא נעקב על נרות ה-5 דקות (יעד לפני סטופ, MFE/MAE ב-R, R אחרי 30/60/120 דקות) ונשמר עם התכונות שלו (נפח יחסי, ATR%, שעה, מרחק מ-MA ועוד). סיכום בלשונית ("איתותים שנעקבו בצל") וייצוא CSV. הנתונים נשמרים 60 יום. אין לזה השפעה על המסחר.
- **אין רענון ברקע:** כל הלשוניות באתר מפסיקות לשאול את השרת כשהדפדפן לא גלוי (`client/src/pollWhileVisible.js`).

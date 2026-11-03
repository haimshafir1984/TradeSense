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

## בדיקות

`server/test/alpacaTrader.test.js` — 7 בדיקות (settings, risk/day-base/breach-latch, entry scoring+sizing+lock, exit stop/breach). רצות עם `broker.js` מדומה (ללא קריאות רשת אמיתיות). `node --test test/*.test.js` מתוך `server/`.

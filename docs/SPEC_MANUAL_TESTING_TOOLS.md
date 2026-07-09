# מסמך איפיון: כלים לבדיקה ידנית מול כסף אמיתי

תאריך: 2026-07-09
סטטוס: מאושר לביצוע
מבצע מיועד: סוכן קוד אוטונומי (Sonnet)

---

## 0. הקשר

המשתמש פותח תיק בדיקה קטן (כמה מאות דולרים) באפליקציית מסחר חיצונית, ורוצה
לבדוק אם ההמלצות של TradeSense באמת שוות משהו - בשני מסלולים מקבילים:

1. **Swing** (טאב "סריקת שוק"): קונה מניה אחת (למשל AMZN) לפי הסריקה,
   מחזיק ~10 ימי מסחר (אופק ה-swing_momentum), ורוצה להשוות את התשואה שלו
   מול SPY לאותו חלון.
2. **Gap-and-go** (טאב "רשימת מעקב למחר"): רוצה לתעד כל בוקר מה היה מחיר
   הפתיחה **בפועל**, מול המחיר שהמערכת הציגה (סגירת היום הקודם), כדי לבדוק
   אם התבנית שהמערכת מזהה בכלל מתממשת בפתיחה.

חלק 1 (הצמדת האחזקה ב"תיק שלי") כבר קיים היום - חסרה רק השוואה מול SPY.
חלק 2 לא קיים בכלל וצריך להיבנות.

## 1. עקרונות מחייבים

1. **בלי אימות משתמשים/multi-tenant.** זו מערכת אישית ל-single user, אותו
   דפוס כמו `portfolioStore.js`/`watchlistStore.json` הקיימים - קובץ JSON
   מקומי, לא DB.
2. **שימוש חוזר בדפוס הקיים בדיוק** ל"השוואה מול SPY": `scanHistoryService.js`
   כבר עושה בדיוק את זה (שומר `spyPriceAtScan`, מחשב `excessReturnPct`
   מול מחיר SPY נוכחי). לשכפל את אותה לוגיקה, לא להמציא חדשה.
3. אחרי כל שלב: `npm test` מ-`server/` (62/62 + טסטים חדשים) ו-
   `npx vite build` מ-`client/` (נקי, למחוק `dist`).
4. commits באנגלית; `git push origin main` בסוף.

## 2. חלק א' — תשואה מול SPY באחזקות ("התיק שלי")

### 2.1 שרת

ב-`portfolioService.js#addHolding`: בזמן ההוספה, לשלוף גם את מחיר ה-SPY
הנוכחי (`marketDataService.getStockSnapshot('SPY')`, בדיוק כמו ש-
`scannerService.js` עושה עם `spyBenchmark?.price`), ולשמור אותו על
ה-holding החדש כ-`spyPriceAtPurchase`. **הערה:** זה זמין רק לאחזקות
שנוספות מעכשיו והלאה - אחזקות קיימות (אם יש) פשוט לא יקבלו את ההשוואה
(שדה `null`), וזה בסדר.

ב-`enrichHolding`: אם יש `spyPriceAtPurchase`, לחשב גם:
```js
const spyReturnPct = ((currentSpyPrice - holding.spyPriceAtPurchase) / holding.spyPriceAtPurchase) * 100;
const excessReturnPct = changeFromBuyPricePct - spyReturnPct; // כבר יש changeFromBuyPricePct בקוד
```
צריך גם את מחיר ה-SPY הנוכחי ב-`getPortfolio` - להוסיף 'SPY' לרשימת
הסימולים שנשלפים (`uniqueTickers`) ולהעביר את ה-snapshot שלו ל-
`enrichHolding`. אם אין `spyPriceAtPurchase` על holding מסוים, השדות
`spyReturnPct`/`excessReturnPct` יהיו `null`.

### 2.2 client

ב-`PortfolioSection.jsx`, בטבלת האחזקות: עמודה נוספת "תשואה מול SPY" -
מציגה `excessReturnPct` (ירוק אם חיובי, אדום אם שלילי) או "-" אם `null`.

### 2.3 טסטים

`server/test/portfolioSpyComparison.test.js`: מוסיפים holding עם mock ל-
`getStockSnapshot('SPY')` שמחזיר מחיר קבוע, ואז קוראים ל-`getPortfolio`
עם mock שמחזיר מחיר SPY אחר (עלה) ומחיר המניה שעלה יותר/פחות - לוודא
ש-`excessReturnPct` מחושב נכון (כולל מקרה שהוא שלילי, וכולל holding בלי
`spyPriceAtPurchase`).

## 3. חלק ב' — תיעוד מחיר פתיחה בפועל ל"רשימת מעקב למחר"

### 3.1 מודל נתונים

קובץ חדש `server/src/data/watchlistOutcomes.json` (ב-`.gitignore`, אותו
דפוס כמו `watchlistCache.json`), דרך מודול חדש
`server/src/services/watchlistOutcomeStore.js` (read/write JSON, אותו
מבנה בדיוק כמו `watchlistStore.js`/`scanHistoryStore.js`).

מבנה: מערך רשומות `{ id, date, ticker, modelClosePrice, actualOpenPrice,
gapAccuracyPct, loggedAt }`, כאשר:
- `date` = תאריך המסחר שאליו הרשימה מתייחסת (`YYYY-MM-DD`, מתוך
  `generatedAt` של ה-watchlist cache באותו יום).
- `modelClosePrice` = השדה `price` שכבר קיים בכל item ב-watchlist (מחיר
  הסגירה ששימש לניקוד).
- `gapAccuracyPct` = `((actualOpenPrice - modelClosePrice) / modelClosePrice) * 100`.

### 3.2 שרת - שירות ו-route

`server/src/services/watchlistOutcomeService.js`:
- `logActualOpen({ date, ticker, actualOpenPrice })` - ולידציה (מחיר
  חיובי), שומר/מעדכן רשומה קיימת לאותו `date`+`ticker` (upsert, לא
  משכפל), מחשב `gapAccuracyPct`, מחזיר את הרשומה.
- `getOutcomesForDate(date)` - מחזיר את כל הרשומות לתאריך נתון, כ-Map
  לפי ticker לנוחות ה-join בצד הלקוח.

Route חדש `server/src/routes/watchlistOutcomes.js`, מורכב תחת
`/api/watchlist/outcomes`:
- `POST /api/watchlist/outcomes` - body `{ date, ticker, actualOpenPrice }`
  → קורא ל-`logActualOpen`, מחזיר את הרשומה.
- `GET /api/watchlist/outcomes?date=YYYY-MM-DD` - מחזיר את כל הרשומות
  לאותו יום.

רישום ב-`app.js`: `app.use('/api/watchlist/outcomes', watchlistOutcomesRouter);`
(**לפני** ה-route הכללי `/api/watchlist` הקיים, או עם path ספציפי מספיק
שלא יתנגש - `watchlist/outcomes` הוא nested תחת `watchlist` הקיים, אז יש
לוודא ב-`app.js` שהוא נרשם כ-router נפרד עם path משלו `/api/watchlist/outcomes`
לפני/אחרי `/api/watchlist`, לא בתוך `routes/watchlist.js` עצמו - לשמור את
שני ה-routers נפרדים).

### 3.3 client

בטאב "רשימת מעקב למחר", לכל שורה בטבלה: תא חדש "מחיר פתיחה בפועל" עם:
- אם עדיין לא תועד לתאריך של היום: input קטן + כפתור "שמור" (קורא ל-
  `POST /api/watchlist/outcomes` עם התאריך של `tomorrowWatchlistGeneratedAt`
  (חתוך ל-`YYYY-MM-DD`) והטיקר של השורה).
- אם כבר תועד: מציג pill עם `gapAccuracyPct` (ירוק אם התאמה לכיוון
  הצפוי - כלומר גאפ חיובי, כמו שהרשימה חוזה מלכתחילה; אדום אחרת), ו-
  אפשרות לערוך מחדש.

בטעינת הטאב (`handleLoadTomorrowWatchlist`), לקרוא גם ל-
`GET /api/watchlist/outcomes?date=...` ולמזג לפי ticker לתוך ה-state
(state חדש `tomorrowWatchlistOutcomes`, `Map`-like object לפי ticker).

### 3.4 טסטים

`server/test/watchlistOutcomeService.test.js` (scratch file, אותו דפוס
env-var-override כמו `watchlistCache.test.js`):
1. `logActualOpen` שומר רשומה חדשה ומחשב `gapAccuracyPct` נכון (גאפ חיובי
   ושלילי).
2. קריאה שנייה לאותו `date`+`ticker` מעדכנת את הרשומה הקיימת (upsert),
   לא משכפלת.
3. `getOutcomesForDate` מחזיר רק את הרשומות של התאריך המבוקש (לא של
   ימים אחרים).
4. ולידציה: מחיר לא חיובי/חסר נדחה עם שגיאה ברורה.

## 4. סדר ביצוע מומלץ (commits)

1. חלק א' - תשואה מול SPY באחזקות (שרת + client + טסטים).
2. חלק ב' - store + service + route + טסטים (שרת בלבד).
3. חלק ב' - client (input שמירה + הצגת דיוק הגאפ).
4. עדכון README (קצר: תיאור שתי התוספות תחת Endpoints/Frontend).

## 5. קריטריוני קבלה

1. `npm test` ירוק במלואו (62 + טסטים חדשים), `npx vite build` נקי.
2. הוספת אחזקה חדשה מציגה "תשואה מול SPY" בטבלה; אחזקה ישנה בלי הנתון
   מציגה "-" ולא קורסת.
3. אפשר לתעד מחיר פתיחה בפועל לכל שורה ברשימת המעקב, והדיוק מוצג מיד.
4. תיעוד כפול לאותו יום+טיקר מעדכן, לא משכפל.
5. אין שינוי בהתנהגות הקיימת של הסריקה הרגילה, הליגה, או המשפך.

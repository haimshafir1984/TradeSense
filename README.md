# TradeSense

TradeSense היא מערכת סריקת מניות עם ממשק משתמש ב־React ושרת API ב־Node.js/Express.

המטרה של המערכת היא לאפשר למשתמש לבחור בורסה, רמת סיכון, שיטת השקעה ופילטרים מתקדמים, ולקבל עד 10 מניות מומלצות לפי לוגיקת סינון וניקוד מוגדרת מראש.

המערכת בנויה כיום כ־MVP production-like:
- צד לקוח יחיד עם טופס ותצוגת תוצאות
- צד שרת יחיד עם endpoint מרכזי אחד לניתוח
- שכבת נתונים חיצונית עם תמיכה ב־FMP וב־Finnhub
- fallback לנתוני demo כדי למנוע קריסה במקרה של כשל בספק הנתונים

## תוכן העניינים

- [סקירה מהירה](#סקירה-מהירה)
- [מחסנית טכנולוגית](#מחסנית-טכנולוגית)
- [מבנה הפרויקט](#מבנה-הפרויקט)
- [איך המערכת עובדת](#איך-המערכת-עובדת)
- [Entry Points](#entry-points)
- [Frontend](#frontend)
- [Backend](#backend)
- [שכבת הנתונים](#שכבת-הנתונים)
- [אסטרטגיות וניקוד](#אסטרטגיות-וניקוד)
- [פילטרים](#פילטרים)
- [מבנה הבקשה ל-API](#מבנה-הבקשה-ל-api)
- [מבנה התשובה מה-API](#מבנה-התשובה-מה-api)
- [משתני סביבה](#משתני-סביבה)
- [הרצה מקומית](#הרצה-מקומית)
- [לוגים ודיבוג](#לוגים-ודיבוג)
- [מגבלות ידועות](#מגבלות-ידועות)
- [כיווני הרחבה עתידיים](#כיווני-הרחבה-עתידיים)

## סקירה מהירה

הזרימה המרכזית במערכת היא:

1. המשתמש ממלא טופס סריקה בממשק.
2. הלקוח שולח `POST /api/analyze`.
3. השרת בוחר מקור נתונים לפי `DATA_MODE`.
4. השרת טוען רשימת סימולים קבועה לפי בורסה.
5. השרת מושך נתוני שוק לכל סימול.
6. השרת מפעיל פילטרים קשיחים.
7. השרת מחשב ניקוד לפי שיטת ההשקעה שנבחרה.
8. התוצאות ממוינות מהגבוה לנמוך.
9. מוחזרות עד 10 תוצאות עם הסבר קצר.

## מחסנית טכנולוגית

### Frontend

- React 19
- Vite
- CSS רגיל

### Backend

- Node.js
- Express 5
- dotenv
- cors

### Data Providers

- Financial Modeling Prep (`fmp`)
- Finnhub (`finnhub`)
- Demo fallback (`demo`)

## מבנה הפרויקט

```text
TradeSense/
├─ client/
│  ├─ package.json
│  ├─ index.html
│  ├─ vite.config.js
│  └─ src/
│     ├─ main.jsx
│     ├─ App.jsx
│     └─ styles.css
├─ server/
│  ├─ package.json
│  └─ src/
│     ├─ index.js
│     ├─ app.js
│     ├─ routes/
│     │  └─ analyze.js
│     ├─ services/
│     │  ├─ scannerService.js
│     │  ├─ marketDataService.js
│     │  └─ strategies.js
│     └─ data/
│        └─ universe.js
├─ .env
├─ .env.example
├─ package.json
└─ README.md
```

## איך המערכת עובדת

### ברמת המשתמש

המשתמש בוחר:
- בורסה
- רמת סיכון
- שיטת השקעה
- פילטרים מתקדמים

לאחר מכן הוא לוחץ על כפתור הסריקה, והמערכת מחזירה טבלת תוצאות.

### ברמת המערכת

השרת מבצע pipeline קבוע:

1. קריאת פרמטרי הבקשה
2. טעינת universe לפי בורסה
3. שליפת נתוני שוק
4. בניית אינדיקטורים ומדדים נגזרים
5. סינון מניות שלא עומדות בתנאים
6. ניקוד לפי אסטרטגיה
7. מיון
8. חיתוך ל־10 תוצאות
9. החזרת response ללקוח

## Entry Points

### Root workspace

הפרויקט מוגדר כ־npm workspaces עם שני workspaces:
- `client`
- `server`

הקובץ:
- `package.json`

הסקריפטים הראשיים:
- `npm run dev` מפעיל במקביל את השרת ואת הלקוח
- `npm run build` בונה את ה־frontend
- `npm run start` מפעיל את השרת

### Client entry point

קובץ הכניסה של הלקוח:
- `client/src/main.jsx`

הוא טוען את:
- `client/src/App.jsx`

### Server entry point

קובץ הכניסה של השרת:
- `server/src/index.js`

הוא:
- טוען משתני סביבה מתוך `.env`
- מפעיל את אפליקציית Express
- מאזין לפורט שהוגדר

## Frontend

### קובץ מרכזי

הקובץ המרכזי של ה־UI הוא:
- `client/src/App.jsx`

### מה קיים במסך

המסך כולל:
- בחירת בורסה
- בחירת רמת סיכון
- בחירת שיטת השקעה
- תצוגת tooltip לכל שיטת השקעה
- פילטרים מתקדמים
- כפתור סריקה
- טבלת תוצאות
- חיווי מקור נתונים
- הודעות מצב ריק / טעינה / שגיאה

### State בלקוח

ה־frontend משתמש ב־React local state בלבד.

אין כיום:
- Redux
- Zustand
- Context store עסקי
- React Query
- persistence מקומי

ה־state המרכזי כולל:
- `form`
- `results`
- `meta`
- `isLoading`
- `error`
- `hasSearched`

### זרימת ה־UI

1. המשתמש מעדכן שדות בטופס.
2. הנתונים נשמרים בתוך `form`.
3. בלחיצה על submit נשלחת בקשת `fetch` ל־`/api/analyze`.
4. בזמן טעינה מוצג מצב `סורק את השוק...`
5. לאחר תשובה:
   - אם הצליח: מוצגות תוצאות
   - אם אין תוצאות: מוצג empty state מתאים
   - אם נכשל: מוצגת הודעת שגיאה

## Backend

### שרת Express

השרת מוגדר ב:
- `server/src/app.js`

מה קיים בו:
- `cors`
- `express.json()`
- `GET /api/health`
- `POST /api/analyze`

### Route מרכזי

ה־route:
- `server/src/routes/analyze.js`

תפקידו:
- לקבל בקשת analyze
- להעביר את הנתונים ל־`analyzeMarket`
- להחזיר JSON ללקוח
- לטפל בשגיאת 500 אם משהו נשבר

### Orchestration עסקי

הקובץ:
- `server/src/services/scannerService.js`

זהו המודול המרכזי שמבצע orchestration לוגי.

הוא אחראי על:
- normalization בסיסי של ה־request
- קריאה ל־`getMarketData`
- הפעלת `applyFilters`
- הפעלת `scoreStockByStrategy`
- מיון תוצאות
- החזרת top 10
- בניית metadata ל־UI

## שכבת הנתונים

### מודול מרכזי

שכבת הנתונים נמצאת ב:
- `server/src/services/marketDataService.js`

### אחריות המודול

המודול אחראי על:
- בחירת ספק נתונים לפי `DATA_MODE`
- טעינת universe של סימולים לפי בורסה
- קריאות ל־API חיצוני
- המרה של הנתונים למבנה פנימי אחיד
- השלמות fallback לערכים חסרים
- fallback ל־demo אם לא התקבלו נתונים חיים

### Universe

רשימת הסימולים מגיעה מ:
- `server/src/data/universe.js`

כרגע הרשימה היא סטטית ומוגדרת בקוד עבור:
- `NASDAQ`
- `NYSE`
- `TASE`

חשוב:
המערכת כיום לא סורקת את כל השוק.
היא סורקת רשימה סגורה של סימולים לכל בורסה.

### מצב מקור נתונים

השרת מחזיר `meta.source` עם אחד מהערכים:

- `fmp`
- `fmp_partial`
- `finnhub`
- `finnhub_partial`
- `demo`

פירוש:

- `fmp`:
  התקבלו נתונים חיים מלאים מספיק מ־FMP

- `fmp_partial`:
  התקבלו רק חלק מהנתונים החיים, והשאר הושלם בפולבקים פנימיים

- `finnhub`:
  התקבלו נתונים חיים מלאים מספיק מ־Finnhub

- `finnhub_partial`:
  התקבלו נתונים חיים חלקיים מ־Finnhub

- `demo`:
  לא היה מספיק מידע חי שימושי, והמערכת חזרה לנתוני דמו

### ספק FMP

כאשר `DATA_MODE=fmp`, המערכת מנסה למשוך:
- quote
- profile
- historical price data

לאחר מכן היא מחשבת מהם:
- מחיר
- שינוי יומי
- נפח
- ממוצע נפח 30 יום
- MA50
- MA200
- שיא 52 שבועות
- שפל 52 שבועות
- תנודתיות
- מדדי עזר נוספים

### ספק Finnhub

כאשר `DATA_MODE=finnhub`, המערכת מנסה למשוך:
- quote
- profile
- metrics
- candles

גם כאן הנתונים ממופים למבנה פנימי אחיד.

### Demo fallback

אם ספק הנתונים לא זמין, או אם חלקים קריטיים נכשלים, המערכת יכולה לייצר stock objects דטרמיניסטיים מתוך seed קבוע.

המטרה היא:
- לשמור על זמינות המערכת
- לאפשר דיבוג ופיתוח גם בלי ספק חיצוני

## אסטרטגיות וניקוד

### מודול אסטרטגיות

האסטרטגיות נמצאות ב:
- `server/src/services/strategies.js`

### אסטרטגיות נתמכות

- `micha_stocks`
- `mark_minervini`
- `ross_cameron`

### מה קורה לפני הניקוד

לפני חישוב score, המערכת מבצעת enrichment של ה־stock ומוסיפה מדדים נגזרים:
- `volumeRatio`
- `highProximity`
- `pullbackFromHigh`
- `relativeStrength`

### Micha Stocks

אסטרטגיית טווח ארוך.

שמה דגש על:
- trend
- growth
- pullback from high
- volume support

### Mark Minervini

אסטרטגיית swing / short term.

שמה דגש על:
- momentum
- trend
- volume
- breakout structure

### Ross Cameron

אסטרטגיית day trading.

שמה דגש על:
- daily momentum
- unusual volume
- breakout behavior
- float proxy לפי market cap

### הסבר קצר לכל תוצאה

כל אסטרטגיה מחזירה גם explanation קצר שנוצר בצורה דטרמיניסטית לפי תנאים ידועים.

ה־UI מציג:
- סימול
- שם חברה
- אחוז התאמה
- שם אסטרטגיה
- הסבר קצר

## פילטרים

הפילטרים מיושמים ב:
- `server/src/services/scannerService.js`

הסינון מתבצע לפני הניקוד.

### פילטרים נתמכים

- `dividendOnly`
- `minDividendYield`
- `sector`
- `marketCap`
- `minVolume`
- `minPrice`
- `maxPrice`
- `volatility`
- `unusualVolume`
- `institutionalBuying`
- `insiderBuying`

### רמות סיכון

בנוסף לפילטרים, יש גם שער סיכון:

- `low`
- `medium`
- `high`

לפי רמת הסיכון, המערכת מפעילה תנאי קשיח על תנודתיות ושווי שוק.

## מבנה הבקשה ל-API

Endpoint:

```http
POST /api/analyze
Content-Type: application/json
```

דוגמת request:

```json
{
  "exchange": "NASDAQ",
  "risk": "medium",
  "strategy": "micha_stocks",
  "filters": {
    "dividendOnly": false,
    "minDividendYield": "",
    "sector": "Any",
    "marketCap": "any",
    "minVolume": "",
    "minPrice": "",
    "maxPrice": "",
    "volatility": "any",
    "unusualVolume": false,
    "institutionalBuying": false,
    "insiderBuying": false
  }
}
```

## מבנה התשובה מה-API

דוגמת response:

```json
{
  "results": [
    {
      "ticker": "AAPL",
      "companyName": "Apple",
      "matchScore": 84,
      "strategyName": "השקעה לטווח ארוך - Micha Stocks",
      "explanation": "נמצאת במגמת עלייה מעל ממוצע 200 יום"
    }
  ],
  "meta": {
    "exchange": "NASDAQ",
    "strategy": "micha_stocks",
    "risk": "medium",
    "source": "fmp_partial",
    "analyzedCount": 8,
    "returnedCount": 8
  }
}
```

### שדות חשובים ב-response

#### results

מערך של עד 10 מניות.

#### meta.exchange

הבורסה שנבחרה.

#### meta.strategy

מפתח האסטרטגיה שנבחר.

#### meta.risk

רמת הסיכון שנבחרה.

#### meta.source

מאיזה מקור נתונים הגיעו התוצאות בפועל.

#### meta.analyzedCount

כמה מניות נשארו אחרי פילטרים.

#### meta.returnedCount

כמה תוצאות הוחזרו בפועל.

## משתני סביבה

המערכת טוענת `.env` מתוך שורש הפרויקט.

קובץ לדוגמה:
- `.env.example`

### משתנים נתמכים

#### PORT

פורט השרת.

דוגמה:

```env
PORT=4000
```

#### CLIENT_ORIGIN

ה־origin שמותר ב־CORS.

דוגמה:

```env
CLIENT_ORIGIN=http://localhost:5174
```

#### DATA_MODE

מקור הנתונים הפעיל.

אפשרויות:
- `fmp`
- `finnhub`

אם לא מוגדר, ברירת המחדל בקוד היא `fmp`.

דוגמה:

```env
DATA_MODE=fmp
```

#### FMP_API_KEY

מפתח API עבור Financial Modeling Prep.

דוגמה:

```env
FMP_API_KEY=your_fmp_key_here
```

#### FINNHUB_API_KEY

מפתח API עבור Finnhub.

דוגמה:

```env
FINNHUB_API_KEY=your_finnhub_key_here
```

### דוגמת .env מומלצת ל-FMP

```env
PORT=4000
CLIENT_ORIGIN=http://localhost:5174
DATA_MODE=fmp
FMP_API_KEY=your_fmp_key_here
```

## הרצה מקומית

### 1. התקנת תלויות

```bash
npm install
```

### 2. יצירת קובץ סביבה

להעתיק את:

```text
.env.example
```

ל־:

```text
.env
```

ואז לעדכן את המפתחות.

### 3. הרצת המערכת

```bash
npm run dev
```

### 4. כתובות ברירת מחדל

בדרך כלל:
- API: `http://localhost:4000`
- Client: `http://localhost:5173`

אם `5173` תפוס, Vite עשוי לעלות על פורט אחר כמו `5174`.

## לוגים ודיבוג

המערכת כוללת לוגים בצד השרת ובצד הלקוח.

### לוגים בשרת

דוגמאות:
- startup env loading
- incoming analyze request
- source selection
- partial provider failures
- completed scan summary

### לוגים בלקוח

בדפדפן ניתן לראות:
- התחלת סריקה
- תשובת השרת
- שגיאות fetch

### Health check

ניתן לבדוק אם השרת פעיל:

```http
GET /api/health
```

תשובה צפויה:

```json
{
  "ok": true
}
```

## מגבלות ידועות

### 1. Universe סטטי

המערכת אינה מושכת רשימת מניות דינמית.
היא סורקת universe קשיח שמוגדר בקוד.

### 2. אין בסיס נתונים

אין persistence ל:
- סריקות עבר
- משתמשים
- sessions
- audit logs

### 3. אין caching

כל סריקה עשויה לבצע קריאות חיצוניות מחדש.

### 4. אין test suite בפרויקט

נכון לעכשיו אין בסביבת הקוד שנבדקה:
- unit tests
- integration tests
- e2e tests

### 5. partial data אפשרי

ספקי הנתונים עלולים להחזיר נתונים חלקיים לפי תוכנית API, rate limits או הרשאות.

### 6. fallbacks פנימיים

גם כאשר מקור הנתונים הוא חי, חלק מהשדות עשויים להיות מחושבים מתוך fallback פנימי אם endpoint מסוים חסום או חסר.

### 7. אין authentication

המערכת כיום פתוחה מקומית ללא מנגנון משתמשים או הרשאות.

## כיווני הרחבה עתידיים

כיוונים אפשריים להמשך:

- הוספת cache לשכבת הנתונים
- הוספת request validation עם schema
- הוספת tests
- הרחבת universe למקורות דינמיים
- שמירת היסטוריית סריקות
- שיפור observability
- הוספת orchestration layer מעל הלוגיקה הקיימת
- הוספת LangGraph כשכבת stateful orchestration, בלי לגעת בליבת scoring וה-filtering

## סיכום

TradeSense כיום היא מערכת דו־שכבתית פשוטה וברורה:
- React בצד הלקוח
- Express בצד השרת

הליבה העסקית נמצאת בשלושה מודולים:
- `scannerService.js`
- `marketDataService.js`
- `strategies.js`

זהו המבנה הנוכחי של המערכת בפועל, על בסיס הקוד הקיים בריפו.

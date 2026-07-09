# TradeSense

TradeSense היא מערכת סריקת מניות עם ממשק משתמש ב־React ושרת API ב־Node.js/Express.

המטרה של המערכת היא לאפשר למשתמש לבחור בורסה, רמת סיכון, שיטת השקעה ופילטרים מתקדמים, ולקבל עד 10 מניות מומלצות לפי לוגיקת סינון וניקוד מוגדרת מראש.

המערכת בנויה כיום כ־MVP production-like:
- צד לקוח יחיד עם טופס ותצוגת תוצאות
- צד שרת יחיד עם endpoint מרכזי אחד לניתוח
- שכבת נתונים חיצונית עם תמיכה ב־FMP וב־Finnhub
- fallback לנתוני demo כדי למנוע קריסה במקרה של כשל בספק הנתונים

> **הסבר פשוט למי שלא רוצה לצלול לפרטים הטכניים:** [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — מדריך בשפה פשוטה, כמעט בלי מונחים באנגלית, שמסביר מה המערכת עושה ומה קורה מאחורי הקלעים.

## תוכן העניינים

- [סקירה מהירה](#סקירה-מהירה)
- [מחסנית טכנולוגית](#מחסנית-טכנולוגית)
- [מבנה הפרויקט](#מבנה-הפרויקט)
- [איך המערכת עובדת](#איך-המערכת-עובדת)
- [Entry Points](#entry-points)
- [Frontend](#frontend)
- [Backend](#backend)
- [שכבת הנתונים](#שכבת-הנתונים)
- [ארכיטקטורת משפך לנתונים](#ארכיטקטורת-משפך-לנתונים)
- [אסטרטגיות וניקוד](#אסטרטגיות-וניקוד)
- [פילטרים](#פילטרים)
- [מבנה הבקשה ל-API](#מבנה-הבקשה-ל-api)
- [מבנה התשובה מה-API](#מבנה-התשובה-מה-api)
- [Endpoints נוספים](#endpoints-נוספים)
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
│  ├─ test/
│  │  └─ *.test.js         (node --test, npm test)
│  └─ src/
│     ├─ index.js
│     ├─ app.js
│     ├─ routes/
│     │  ├─ analyze.js
│     │  ├─ portfolio.js
│     │  ├─ scanHistory.js         (GET /api/scan-history/outcomes)
│     │  ├─ strategyLeague.js      (GET /api/strategy-league)
│     │  └─ watchlist.js           (GET /api/watchlist/tomorrow)
│     ├─ config/
│     │  └─ scoringConfig.js    (weights/thresholds/regime-recommendation map in one place)
│     ├─ services/
│     │  ├─ scannerService.js         (orchestration)
│     │  ├─ marketDataService.js      (data layer + provider fallback)
│     │  ├─ strategies.js             (scoring per strategy)
│     │  ├─ analysisService.js        (data quality, confidence, confluence, risk)
│     │  ├─ marketRegimeService.js    (bull/bear/volatile detection + breadth + recommended strategy)
│     │  ├─ opportunityScoringService.js  (opportunityRank / upside estimate)
│     │  ├─ expertSupportService.js   (per-strategy "style match" badges)
│     │  ├─ indiOverlayService.js     (short-strategy fit overlay)
│     │  ├─ explanationService.js     (enriched per-result explanation text)
│     │  ├─ scanHistoryService.js     (persist scans, measure outcomes vs SPY, strategy league)
│     │  ├─ scanHistoryStore.js
│     │  ├─ watchlistService.js       (next-session gap-and-go candidates, cached per exchange)
│     │  ├─ watchlistStore.js         (cache file, one entry per exchange)
│     │  ├─ watchlistScheduler.js     (runs the scan automatically each evening)
│     │  ├─ portfolioService.js       (holdings/watchlist, separate feature)
│     │  ├─ portfolioStore.js
│     │  └─ mathUtils.js              (shared clamp/round/average)
│     └─ data/
│        └─ universe.js
├─ docs/
│  └─ LOGIC_IMPROVEMENTS.md   (known issues + roadmap for the scoring logic)
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
- בחירת שיטת השקעה (כולל `swing_momentum`)
- תצוגת tooltip לכל שיטת השקעה
- badge "מובילה ב-90 הימים" ליד בורר האסטרטגיה (מ-`GET /api/strategy-league`)
- פילטרים מתקדמים
- כפתור סריקה
- טבלת תוצאות
- חיווי מקור נתונים ומצב שוק, כולל הערת המלצת אסטרטגיה מותנית-regime (או מבוססת ליגה, אם קיימת)
- פאנל "רשימת מעקב למחר" (gap-and-go, `GET /api/watchlist/tomorrow`) עם דיסקליימר EOD מפורש
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
- `POST /api/portfolio/*`
- `GET /api/scan-history/outcomes`
- `GET /api/strategy-league`
- `GET /api/watchlist/tomorrow`

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

זהו המודול המרכזי שמבצע orchestration לוגי. ה־pipeline המלא:

1. שליפת נתוני שוק (`getMarketData`) ומדדי ייחוס SPY/QQQ/IWM (`getStockSnapshots`)
2. הפעלת פילטרים קשיחים שהמשתמש ביקש (`applyFilters`) - **לא** כולל את רמת הסיכון
3. ניקוד לפי אסטרטגיה (`scoreStockByStrategy`), כולל `relativeStrength` אמיתי מול תשואת SPY
4. קנס רציף לפי רמת הסיכון (`applyRiskFitPenalty`) - טאפר חלק, לא חיתוך בינארי
5. מיון וחיתוך ל־10 מועמדים מקסימום
6. סף איכות מינימלי (`QUALITY_SCORE_THRESHOLD`) - מועמד חלש לא מוצג כהמלצה גם אם הוא בין העשירייה
7. לכל תוצאה שעוברת את הסף: שכבות overlay נוספות -
   `confluence` (הסכמה בין אסטרטגיות, מנורמל ל־percentile בתוך ה־universe הנסרק),
   `expertSupport`, `riskOverlay`, `opportunity` (`opportunityRank`/`estimatedUpside`/`expectedReturnPct`),
   `indiFit` (לאסטרטגיות קצרות בלבד), הסבר מועשר
8. `marketRegime` מחושב פעם אחת לכל הסריקה, משלב גם קריאת breadth על כל ה־universe (לא רק 3 ה־ETF)
9. בניית `meta`/`analysis`/`summary` ללקוח

מפת פירוט הבעיות הידועות בלוגיקה הזו נמצאת ב־[`docs/LOGIC_IMPROVEMENTS.md`](docs/LOGIC_IMPROVEMENTS.md).

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

רשימת ברירת המחדל (סטטית) מגיעה מ:
- `server/src/data/universe.js`

עבור `NASDAQ`/`NYSE` במצב `DATA_MODE=fmp`, המערכת מנסה קודם universe **דינמי** דרך ה-screener של FMP (`stable/company-screener`, מניות actively-trading), ורק אם הקריאה נכשלת/ריקה חוזרת לרשימה הסטטית. `TASE` תמיד משתמשת ברשימה הסטטית (עם מיפוי `.TA`, ראו שכבת הנתונים למטה).

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

## ארכיטקטורת משפך לנתונים

"רשימת המעקב למחר" (gap-and-go, ראו סעיף Endpoints נוספים) דורשת סינון על אלפי מניות כדי למצוא מועמדים אמיתיים - לא משיכה יקרה של ~40 סימולים פר-מניה (4 קריאות FMP לכל אחד), שמצליחה לשרוף כמעט את כל תקציב ה-free tier היומי (~250 קריאות) בסריקה קרה אחת. הפתרון: ארכיטקטורת **משפך (funnel)** תלת-שלבית, שמושכת נתוני יום של אלפי מניות בבת אחת מ-Alpaca (חינמי, batch) ומצמצמת בהדרגה עד ל-10-20 פינליסטים בלבד לפני שהיא בכלל פונה ל-FMP.

```
שלב 1 — רחב וזול:   נתוני יום של אלפי מניות US בבת אחת (Alpaca, batch)
                      ↓ סינון גס מקומי (מחיר, נפח דולרי, שינוי יומי)
שלב 2 — בינוני:      היסטוריית 90 יום לכמה מאות ששרדו (Alpaca, batch)
                      ↓ ADR/volumeRatio/highProximity מקומי + הסינון המלא הקיים
שלב 3 — צר ויקר:     העשרת FMP (market cap, earnings) ל-10-20 פינליסטים בלבד
```

### טבלת הספקים ותפקידם

| ספק | תפקיד ב-funnel | קובץ |
|---|---|---|
| Alpaca | שלבים 1-2: universe רחב + היסטוריה, זול/חינמי | `server/src/services/providers/alpacaService.js` |
| FMP | שלב 3 בלבד: market cap + earnings calendar, לפינליסטים בלבד | `watchlistScoring.js` (`checkEarningsSoon`) + `funnelScanService.js` |

FMP **לא מוחלף** - הוא ממשיך לשרת גם את שאר המערכת (`marketDataService.js`) בדיוק כמו היום; ה-funnel הוא תוסף שמופעל אך ורק עבור "רשימת המעקב למחר".

### Fallback מלא כשאין מפתחות Alpaca

`funnelScanService.scanForGapAndGo` מחזירה `null` אם `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` לא מוגדרים בסביבה, או אם שלב 1 נכשל (universe/bars ריקים). `watchlistService.buildTomorrowWatchlist` מפרש `null` כסימן ליפול בדיוק למסלול הישן - universe של FMP + אותם הספים הקיימים - כך שללא מפתחות Alpaca ההתנהגות זהה ביט-לביט להיום. מערך ריק שמוחזר מה-funnel כן מתקבל כתוצאה לגיטימית ("אין היום מועמדים אמיתיים").

כל שגיאת HTTP או exception מול Alpaca נבלעת בשקט (`console.warn`) ומטופלת כ"נכשל" - שום ספק בודד לא יכול לגרום לשגיאה כלפי המשתמש.

### משתני הסביבה של ה-funnel

```env
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
FUNNEL_MIN_PRICE=1
FUNNEL_MAX_PRICE=500
FUNNEL_MIN_DOLLAR_VOLUME=5000000
FUNNEL_STAGE2_SIZE=300
FUNNEL_FINALISTS=20
```

כל הספים נקראים עם ברירות מחדל בקוד; משתני הסביבה הם דריסה בלבד. פירוט מלא בסעיף [משתני סביבה](#משתני-סביבה).

### תיקוני production שהתגלו רק מול מפתחות אמיתיים

שני באגים שלא נתפסו בטסטים (שרצים על mock) ונמצאו רק בהרצה אמיתית מול חשבונות free tier:

1. **מפתח Paper של Alpaca.** חשבון Alpaca חינמי מנפיק מפתחות "paper" (מתחילים ב-`PK`), שמקבלים 401 מהשרת ה"חי" (`api.alpaca.markets`) לבקשת רשימת הנכסים. `alpacaService.js` מזהה אוטומטית מפתח `PK*` ופונה במקום זה ל-`paper-api.alpaca.markets` (שרת נתוני המחיר עצמו, `data.alpaca.markets`, מקבל את שני סוגי המפתחות ולא צריך שינוי). ניתן לדרוס ידנית עם `ALPACA_TRADING_BASE_URL`.
2. **דגל "דוח בקרוב" שקרי.** לוח הדוחות (`earnings-calendar`) של FMP במסלול החינמי מתעלם מפרמטר הסינון לפי סימול ומחזיר את לוח הדוחות הכללי של כל השוק - סימון "יש דוח קרוב" בלי סינון היה מסמן כמעט כל מניה. `checkEarningsSoon` ב-`watchlistScoring.js` מסנן כעת בעצמו רק ערכים שה-`symbol` שלהם תואם בפועל לטיקר המבוקש.

## אסטרטגיות וניקוד

### מודול אסטרטגיות

האסטרטגיות נמצאות ב:
- `server/src/services/strategies.js`

### אסטרטגיות נתמכות

- `micha_stocks`
- `mark_minervini`
- `ross_cameron`
- `swing_momentum`

### מה קורה לפני הניקוד

לפני חישוב score, המערכת מבצעת enrichment פעם אחת (`enrichStock`) ומוסיפה מדדים נגזרים, שנשמרים על ה־stock ומשמשים גם את שכבות ה־overlay (כדי שלא יחושבו כפול):
- `volumeRatio`
- `highProximity`
- `pullbackFromHigh`
- `relativeStrength` - תשואת המניה ב־~63 ימי מסחר (`return_3m`) פחות תשואת ה־SPY לאותו חלון, מנורמל. זו הצלבה אמיתית מול השוק, לא מדד פנימי בלבד.

המשקלים של כל אסטרטגיה מוגדרים במרוכז ב־`server/src/config/scoringConfig.js`.

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

### Swing Momentum

אסטרטגיית swing מבוססת סגנון (ללא שם סוחר אמיתי חדש - ראו `docs/LOGIC_IMPROVEMENTS.md`).

הציון הוא המקסימום בין שני תתי-סטאפ עצמאיים:
- **Breakout** - קונסולידציה צמודה (`consolidation_score`) שנפרצת קרוב לשיא (`highProximity>=0.9`), עם נפח חריג וחוזק יחסי גבוה, מעל ממוצעים עולים.
- **Episodic Pivot** - גאפ גדול או תנועה יומית חדה (`gap_pct`/`daily_change`) עם נפח חריג ביותר - מהלך מונע קטליזטור, לא פריצה טכנית.

פילטר כשירות (מכפיל 0 אם לא עומד בו): `adr_pct>=3.5` (טווח תנודה יומי ממוצע ב-20 הימים האחרונים) ומחיר מעל `MA200`. מניה "רדומה" (ADR נמוך) לא תדורג לפי שאר הגורמים - היא נפסלת.

`adr_pct` ו-`gap_pct` מחושבים ב-`marketDataService.js` מתוך היסטוריית המחירים (וגם עבור נתוני דמו).

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

> הוסרו פילטרי `institutionalBuying`/`insiderBuying` - הם סיננו לפי נתוני "קנייה מוסדית"/"קניית פנים" שהיו למעשה תמיד ערכים אקראיים מדומים, גם במצב live. ראו סעיף 2.1 ב-`docs/LOGIC_IMPROVEMENTS.md`.

### רמות סיכון

בנוסף לפילטרים, יש גם פרופיל סיכון:

- `low`
- `medium`
- `high`

בניגוד לפילטרים למעלה, רמת הסיכון **אינה** חיתוך בינארי. היא מפעילה קנס רציף (`riskFitPenalty`, 0.15–1.0) על ציון המניה לפי מרחק מהטווח האידאלי של תנודתיות/שווי שוק - מניה שלא מתאימה עדיין יכולה להופיע, בדירוג נמוך יותר, אם האות הבסיסי חזק מספיק.

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
    "unusualVolume": false
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
      "explanation": "נמצאת במגמת עלייה מעל ממוצע 200 יום",
      "opportunityRank": 78,
      "estimatedUpsideRange": "8% - 20%",
      "expectedReturnPct": 10.9,
      "riskFitPenalty": 1,
      "imputedFields": [],
      "dataSource": "fmp",
      "confluence": { "level": "medium", "percentileByStrategy": { "micha_stocks": 90 } },
      "riskOverlay": { "level": "low", "score": 1 }
    }
  ],
  "meta": {
    "exchange": "NASDAQ",
    "strategy": "micha_stocks",
    "risk": "medium",
    "source": "fmp_partial",
    "analyzedCount": 8,
    "returnedCount": 8,
    "noQualitySetups": false
  }
}
```

### שדות חשובים ב-response

#### results

מערך של עד 10 מניות שעברו גם את סף האיכות המינימלי (ראו `meta.noQualitySetups`).

- `opportunityRank` - ציון הזדמנות **יחסי** (0–100), לא הסתברות סטטיסטית מכוילת. שם השדה שונה במכוון מ-`successProbability` הישן כדי לא להטעות.
- `imputedFields` - אילו שדות של המניה הזו הושלמו אוטומטית (seeded) בהיעדר נתון חי, גם כש-`dataSource` נראה live.
- `riskFitPenalty` - עד כמה המניה מתאימה לפרופיל הסיכון שנבחר (1 = מתאימה במלואה).
- `confluence.percentileByStrategy` - ציון כל אסטרטגיה כ-percentile בתוך ה-universe הנסרק, בר-השוואה בין אסטרטגיות (בניגוד לציון הגולמי).

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

כמה תוצאות הוחזרו בפועל (אחרי סף האיכות).

#### meta.noQualitySetups

`true` כאשר היו מועמדים לאחר סינון, אך אף אחד מהם לא עבר את סף הציון המינימלי - כלומר "אין כרגע סטאפים איכותיים", בניגוד ל"אין תוצאות כי הפילטרים היו צרים מדי".

#### analysis.marketRegime.recommendedStrategy

מפתח ותווית של האסטרטגיה המומלצת בתנאי השוק הנוכחיים, פלוס `source`:
- `regime` - נקבע לפי `REGIME_RECOMMENDED_STRATEGY` ב-`scoringConfig.js` (בשוק דובי - `null`, "עדיף להמתין").
- `league` - כאשר לליגת האסטרטגיות (ראו למטה) יש מובילה מדדת עם מספיק דגימות, היא גוברת על ברירת המחדל לפי מצב השוק.

## Endpoints נוספים

### GET /api/scan-history/outcomes

מריץ הערכת תוצאות לכל הסריקות שעברו את אופק הזמן שלהן (מול מדד SPY), ומחזיר דו"ח hit-rate כללי, פר אסטרטגיה ופר `opportunityRank` bucket. לוגיקת ההערכה וההיסטוריה עצמה נמצאות ב-`scanHistoryService.js`/`scanHistoryStore.js`.

### GET /api/strategy-league

מחזיר "ליגת אסטרטגיות" - טבלת hit-rate ותשואה עודפת ממוצעת מול SPY, פר אסטרטגיה, על סמך 90 הימים האחרונים בלבד. כל סריקה שומרת לא רק את תוצאות האסטרטגיה שנבחרה אלא גם Top-5 מכל אסטרטגיה אחרת (מנוקד על אותו universe), כך שאפשר למדוד איך כל אסטרטגיה הייתה מתפקדת - לא רק זו שנבחרה בפועל. אסטרטגיה מוכרזת "מובילה" (`leadingStrategy`) רק מעל סף מינימלי של דגימות (10); מתחת לכך השדה `null`.

```json
{
  "windowDays": 90,
  "minSamplesToLead": 10,
  "byStrategy": {
    "micha_stocks": { "count": 12, "hits": 7, "hitRatePct": 58.3, "avgExcessReturnPct": 1.4 }
  },
  "leadingStrategy": "swing_momentum"
}
```

### GET /api/watchlist/tomorrow?exchange=NASDAQ

מחזיר עד 10 מועמדים ל-gap-and-go ליום המסחר הבא, מחושבים מסריקת סוף היום הנוכחי: שווי שוק מתחת ל-10 מיליארד, `adr_pct>=3`, יחס נפח `>=1.2`, ועלייה יומית חיובית. מדורגים לפי שילוב של עלייה יומית/נפח/קרבה לשיא, ומועשרים (כשיש `FMP_API_KEY`) בסימון `hasEarningsSoon` - דוח כספים בשלושת ימי המסחר הקרובים (קטליזטור אפשרי, אך גם סיכון).

**המקור בפועל תלוי אם מוגדרים מפתחות Alpaca** (ראו [ארכיטקטורת משפך לנתונים](#ארכיטקטורת-משפך-לנתונים)):
- **עם מפתחות** - `funnelScanService.js` סורק universe רחב דרך Alpaca ומחזיר תוצאה עם `dataSource: 'alpaca+fmp'`.
- **בלי מפתחות** (או אם ה-funnel נכשל) - נופל בדיוק למסלול הישן דרך `watchlistService.js`/`marketDataService.js`, עם `dataSource: 'fmp-universe'`.

התשובה כוללת שדה `dataSource` ברמת ה-root (מהפריט הראשון ברשימה, או `'none'` אם הרשימה ריקה), וה-UI מציג לפיו chip קטן ("מקור: סריקת שוק רחבה" / "מקור: מדגם מצומצם") ליד חותמת הזמן בפאנל.

**חשוב:** התוצאות מבוססות נתוני סוף יום בלבד - יש לאמת מול מחירי פתיחה בזמן אמת לפני כל החלטה. ה-UI מציג דיסקליימר מפורש בפאנל הזה.

#### חישוב אוטומטי בכל ערב (caching + scheduler)

התוצאה נשמרת ב-cache פר-בורסה (`server/src/data/watchlistCache.json`, לא ב-git). `watchlistScheduler.js` בודק כל 15 דקות אם השעה עברה את `WATCHLIST_SCHEDULE_HOUR` (ברירת מחדל: 22:00, שעון השרת) עבור אותו יום, ואם כן - מריץ חישוב מחדש עבור הבורסות ב-`WATCHLIST_SCHEDULE_EXCHANGES` (ברירת מחדל: `NASDAQ,NYSE`). כך כשנכנסים למערכת בבוקר/בערב, `GET /api/watchlist/tomorrow` פשוט מגיש תוצאה שכבר מוכנה - בלי המתנה.

תוסף `?refresh=true` לכתובת כדי לאלץ חישוב מחדש מיידי (זה מה שכפתור "רענן עכשיו" ב-UI עושה). אם ה-cache ישן מ-12 שעות, הוא מתעדכן ממילא אוטומטית בבקשה הבאה, גם אם ה-scheduler לא הספיק לרוץ (למשל אם השרת לא רץ בערב).

**מגבלה חשובה:** האוטומציה הזו פועלת רק כל עוד תהליך ה-server פעיל בזמן השעה המתוזמנת. בהרצה מקומית (`npm run dev`) המחשב צריך להיות דלוק והשרת פעיל ב-22:00 כדי שהריענון יקרה בפועל; אם רוצים "כל ערב באמת" בלי תלות במחשב האישי, צריך לפרוס את השרת לסביבה שרצה 24/7 (למשל שרת ענן קטן).

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

#### FMP_UNIVERSE_SIZE

מספר הסימולים שנשלפים מ-universe דינמי (FMP screener) עבור NASDAQ/NYSE. ברירת מחדל: `40`. universe גדול יותר = יותר סיכוי למועמדים (בעיקר לרשימת המעקב למחר ולאסטרטגיות קצרות), אבל גם יותר קריאות API לכל סריקה (‏~4 קריאות לכל סימול נוסף).

```env
FMP_UNIVERSE_SIZE=40
```

#### WATCHLIST_SCHEDULE_HOUR

השעה (0–23, שעון השרת) שבה "רשימת המעקב למחר" מתעדכנת אוטומטית בכל ערב. ברירת מחדל: `22`.

**חשוב בפריסה לענן (למשל Render):** "שעון השרת" הוא בדרך כלל **UTC**, לא שעון ישראל. כדי שהריענון יקרה סביב 22:00 שעון ישראל בפועל, יש להגדיר את המשתנה בהתאם - למשל `19` בקיץ (שעון קיץ UTC+3) או `20` בחורף (UTC+2).

#### WATCHLIST_SCHEDULE_EXCHANGES

רשימת בורסות (מופרדות בפסיק) שמתעדכנות אוטומטית. ברירת מחדל: `NASDAQ,NYSE`.

```env
WATCHLIST_SCHEDULE_HOUR=22
WATCHLIST_SCHEDULE_EXCHANGES=NASDAQ,NYSE
```

#### ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY

מפתחות API עבור Alpaca Market Data (v2), משמשים אך ורק את [ארכיטקטורת משפך הנתונים](#ארכיטקטורת-משפך-לנתונים) של "רשימת המעקב למחר". אם לא מוגדרים - "רשימת המעקב למחר" ממשיכה לעבוד בדיוק כמו היום, דרך `marketDataService`/FMP.

```env
ALPACA_API_KEY_ID=your_alpaca_key_id_here
ALPACA_API_SECRET_KEY=your_alpaca_secret_key_here
```

#### FUNNEL_MIN_PRICE / FUNNEL_MAX_PRICE

טווח המחיר (סגירה אחרונה) שסינון השלב הגס (שלב 1 ב-funnel) מקבל. ברירת מחדל: `1`–`500`.

#### FUNNEL_MIN_DOLLAR_VOLUME

סף נפח מסחר דולרי מינימלי (מחיר × נפח) לסינון הגס בשלב 1. ברירת מחדל: `5000000`.

#### FUNNEL_STAGE2_SIZE

כמה שורדי-שלב-1 (מקסימום) עוברים לשלב 2 (משיכת היסטוריה מלאה וחישוב ADR/volumeRatio/highProximity). ברירת מחדל: `300`.

#### FUNNEL_FINALISTS

כמה פינליסטים (מקסימום) עוברים לשלב 3 (העשרת FMP - market cap + earnings). ברירת מחדל: `20`.

```env
FUNNEL_MIN_PRICE=1
FUNNEL_MAX_PRICE=500
FUNNEL_MIN_DOLLAR_VOLUME=5000000
FUNNEL_STAGE2_SIZE=300
FUNNEL_FINALISTS=20
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

### 1. Universe

עבור NASDAQ/NYSE במצב FMP יש universe דינמי (FMP screener) עם נפילה לרשימה סטטית, בגודל מוגדר ב-`FMP_UNIVERSE_SIZE` (ברירת מחדל: 40). TASE ובמצב demo/Finnhub עדיין תמיד סטטיים (~20 סימולים). בכל מקרה מדובר במדגם מוגבל לסריקה - לא סריקה של כל השוק, וגודל universe גדול יותר פירושו יותר קריאות API לכל סריקה.

### 2. אין בסיס נתונים

אין persistence ל:
- סריקות עבר
- משתמשים
- sessions
- audit logs

### 3. Caching

יש caching בזיכרון (לא persistent, נמחק בכל restart) בשלוש רמות: תוצאות בקשת HTTP גולמיות (10 דק'), snapshot שוק מלא לבורסה (5 דק'), snapshot מניה בודדת (5 דק'). זה מפחית קריאות חוזרות בטווח קצר בלבד.

### 4. Test suite

יש `server/test/` עם בדיקות דרך Node's built-in `node:test` (`npm test` מתוך `server/`). הבדיקות מכסות בעיקר את שכבת ה-scoring/scanning ולא כוללות UI/e2e.

### 5. partial data אפשרי

ספקי הנתונים עלולים להחזיר נתונים חלקיים לפי תוכנית API, rate limits או הרשאות.

### 6. fallbacks פנימיים

גם כאשר מקור הנתונים הוא חי, חלק מהשדות עשויים להיות מחושבים מתוך fallback פנימי (seeded) אם endpoint מסוים חסום או חסר. כל מניה כזו מסומנת ב-`imputedFields` בתשובת ה-API, ומשפיעה על `confidenceScore` ועל שער הסיכון - אבל השדה עדיין מוצג בטבלה כאילו הוא נתון רגיל, כך שכרגע אין חיווי חזותי ב-UI עצמו לכך שהוא מחושב.

### 7. אין authentication

המערכת כיום פתוחה מקומית ללא מנגנון משתמשים או הרשאות.

## כיווני הרחבה עתידיים

כיוונים אפשריים להמשך (מפורטים יותר ב-[`docs/LOGIC_IMPROVEMENTS.md`](docs/LOGIC_IMPROVEMENTS.md)):

- הוספת request validation עם schema
- earnings calendar וסימון סנטימנט/חדשות כ-flag
- universe דינמי גם ל-Finnhub ול-TASE
- מעבר מ-JSON file store ל-DB אמיתי ל-scan history/portfolio ככל שהנפח גדל
- שיפור observability
- הוספת orchestration layer מעל הלוגיקה הקיימת
- הוספת LangGraph כשכבת stateful orchestration, בלי לגעת בליבת scoring וה-filtering

## סיכום

TradeSense כיום היא מערכת דו־שכבתית:
- React בצד הלקוח
- Express בצד השרת

הליבה העסקית מחולקת ל-8 שירותים (ראו [מבנה הפרויקט](#מבנה-הפרויקט)): שכבת נתונים (`marketDataService.js`), ניקוד (`strategies.js`), ואורקסטרציה (`scannerService.js`) שמפעילה סדרת שכבות overlay - איכות/ביטחון נתונים, מצב שוק, הסכמה בין אסטרטגיות, "תמיכת מומחים", סיכון, והזדמנות - שכל אחת מהן מיושמת בקובץ נפרד. יש גם שכבת portfolio נפרדת (holdings/watchlist).

מסמך [`docs/LOGIC_IMPROVEMENTS.md`](docs/LOGIC_IMPROVEMENTS.md) מתעד ממצאים ידועים ותוכנית שיפור מסודרת ללוגיקת ההמלצות; חלק ניכר מהסעיפים שם כבר יושמו.

זהו המבנה הנוכחי של המערכת בפועל, על בסיס הקוד הקיים בריפו.

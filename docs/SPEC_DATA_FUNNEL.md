# מסמך איפיון: ארכיטקטורת משפך לשכבת הנתונים (Data Funnel)

תאריך: 2026-07-09
סטטוס: מאושר לביצוע
מבצע מיועד: סוכן קוד אוטונומי (Sonnet)

---

## 0. תקציר מנהלים

המערכת כיום מושכת נתונים "פר-מניה" (4 קריאות FMP לכל סימול), על universe של עד 40 סימולים, תחת מגבלת free tier של ~250 קריאות ליום. סריקה קרה אחת שורפת ~160 קריאות — רוב התקציב היומי — וחלק מהקריאות נכשל בשקט. התוצאה: "רשימת המעקב למחר" (gap-and-go) כמעט תמיד ריקה, כי gap-and-go דורש **סינון על אלפי מניות**, לא משיכה יקרה של 40.

הפתרון: ארכיטקטורת **משפך (Funnel)** —

```
שלב 1 — רחב וזול:   נתוני יום של אלפי מניות US בבת אחת (Alpaca, batch, חינמי)
                      ↓ סינון גס מקומי (מחיר, נפח, שינוי יומי)
שלב 2 — בינוני:      היסטוריית 60 יום לכמה מאות ששרדו (Alpaca, batch)
                      ↓ חישוב ADR/volumeRatio/highProximity מקומי + סינון מלא
שלב 3 — צר ויקר:     העשרה ל-10-20 פינליסטים בלבד (FMP: earnings, profile)
```

FMP **לא מוחלף** — תפקידו מצטמצם לשלב 3, שבו הוא מצוין (fundamentals, earnings calendar) והתקציב מספיק. אם אין מפתחות Alpaca — המערכת ממשיכה לעבוד בדיוק כמו היום (fallback מלא).

---

## 1. עקרונות מנחים (חובה לקיים)

1. **אפס רגרסיה:** כל הטסטים הקיימים (50) חייבים להמשיך לעבור. אין לשנות התנהגות קיימת כשמפתחות Alpaca חסרים.
2. **החלפה הדרגתית, לא bing-bang:** ה-funnel מיושם קודם עבור ה-watchlist בלבד (שם הכאב). ה-pipeline של `analyzeMarket` לא משתנה בשלב זה.
3. **כל ספק מאחורי adapter:** אסור לקרוא ל-fetch של Alpaca מחוץ לקובץ ה-adapter. ממשק אחיד, כך שספק עתידי (Tiingo/Stooq) יתווסף בלי לגעת בלוגיקה.
4. **Fail-soft:** כל כשל ב-Alpaca מדרדר בשקט (עם console.warn) למסלול הקיים (FMP universe). אף פעם לא זורקים שגיאה למשתמש בגלל ספק אחד.
5. **אין להזין את אותו סיגנל גולמי פעמיים לציון אחד** (עקרון 3.1 הקיים במסמך LOGIC_IMPROVEMENTS).
6. **בלי שמות סוחרים אמיתיים חדשים** בתוויות UI.
7. אחרי כל שלב: `npm test` מתוך `server/`, ואז `npx vite build` מתוך `client/` (ומחיקת `dist`). commit עם הודעה באנגלית שמסבירה למה. בסוף הכול: `git push origin main`.
8. טסטים חדשים משתמשים ב-mock ל-`global.fetch` וב-monkey-patching של מודולים (ראה דפוס קיים ב-`server/test/watchlistCache.test.js` ו-`dynamicUniverse.test.js`). אסור לטסט לפנות לרשת אמיתית.

---

## 2. מצב קיים (רלוונטי לשינוי)

- `server/src/services/marketDataService.js` — שכבת הנתונים: `getMarketData(exchange)`, `getStockSnapshot(ticker)`, `getStockSnapshots(tickers)`. ספקים: FMP (ברירת מחדל), Finnhub, דמו. universe דינמי דרך FMP screener (עד `FMP_UNIVERSE_SIZE=40`).
- `server/src/services/watchlistService.js` — בונה את רשימת המעקב למחר מ-`getMarketData` (כלומר מאותם ≤40 סימולים). ספים: market_cap<10B, adr_pct≥3, volumeRatio≥1.2, daily_change>0. cache פר-בורסה ב-`watchlistStore.js`.
- `server/src/services/watchlistScheduler.js` — מרענן את ה-cache כל ערב (ברירת מחדל 22:00) ל-NASDAQ/NYSE.
- צרכני `marketDataService`: `scannerService`, `scanHistoryService`, `portfolioService`, `watchlistService`.

---

## 3. שינויים נדרשים

### 3.1 קובץ חדש: `server/src/services/providers/alpacaService.js`

Adapter יחיד לכל התקשורת עם Alpaca Market Data API (v2).

**אימות:** headers ‏`APCA-API-KEY-ID` ו-`APCA-API-SECRET-KEY` מתוך env ‏(`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`).
**Base URL:** ‏`https://data.alpaca.markets` (ניתן לדריסה ב-`ALPACA_DATA_BASE_URL` לצורכי טסט). ל-assets: ‏`https://api.alpaca.markets` (דריסה: `ALPACA_TRADING_BASE_URL`).

פונקציות מיוצאות:

1. `isConfigured()` — האם שני המפתחות קיימים ב-env.
2. `getActiveAssets({ exchange })` — ‏`GET /v2/assets?status=active&asset_class=us_equity`. מסנן בצד שלנו: `tradable===true`, ו-`exchange` תואם (Alpaca מחזירה `NASDAQ`/`NYSE`/`ARCA`...; למפות בקשת `NYSE` גם ל-`NYSE` וגם ל-`ARCA`? **לא** — רק התאמה מדויקת ל-NASDAQ/NYSE). להחזיר `[{ symbol, name, exchange }]`. לסנן החוצה סימולים עם `/` או `.` (מניות בכורה/וורנטים).
3. `getDailyBars({ symbols, days })` — ‏`GET /v2/stocks/bars?symbols=A,B,C&timeframe=1Day&start=...&limit=10000&adjustment=split&feed=iex&sort=asc`. חובה:
   - לפצל ל-chunks של עד **200 סימולים** לקריאה (מגבלת אורך URL בפועל).
   - לטפל ב-pagination דרך `next_page_token` עד מיצוי.
   - `start` = היום פחות `days` ימים קלנדריים (ברירת מחדל 90 קלנדרי ≈ 60 ימי מסחר).
   - להחזיר `Map<symbol, bars[]>` כאשר bar = `{ t, o, h, l, c, v }` כפי שמגיע מה-API, ממוין מהישן לחדש.
4. `getLatestDailyBars({ symbols })` — כמו (3) אבל `days=7` ולוקח רק את ה-bar האחרון לכל סימול. (נפרד כדי ששלב הסינון הגס יהיה זול.)

**Rate limiting:** ‏free tier = ‏200 בקשות/דקה. להוסיף השהיה פשוטה: אם בוצעו ≥190 קריאות ב-60 השניות האחרונות — להמתין עד פתיחת החלון (setTimeout). מימוש מינימלי, בלי ספריות חדשות.
**שגיאות:** כל non-2xx או exception ⇒ ‏`console.warn` + החזרת `null`/Map ריקה, לפי הפונקציה. אסור לזרוק.
**אסור להוסיף תלות npm חדשה** — ‏fetch מובנה בלבד.

### 3.2 קובץ חדש: `server/src/services/funnelScanService.js`

מנוע המשפך. פונקציה מרכזית אחת:

`scanForGapAndGo({ exchange }) → Promise<candidates[] | null>`

מחזירה `null` אם `!alpacaService.isConfigured()` או אם שלב 1 נכשל — הסימן ל-caller ליפול למסלול הישן.

**שלב 1 — universe + סינון גס:**
1. `getActiveAssets({ exchange })`. אם ריק/null ⇒ `null`.
2. `getLatestDailyBars` על כל הסימולים (ב-chunks).
3. סינון גס מקומי על ה-bar האחרון:
   - מחיר סגירה בין `FUNNEL_MIN_PRICE` (ברירת מחדל 1) ל-`FUNNEL_MAX_PRICE` (ברירת מחדל 500)
   - נפח דולרי (close×volume) ≥ `FUNNEL_MIN_DOLLAR_VOLUME` (ברירת מחדל 5,000,000)
   - שינוי יומי חיובי: ‏(close−open)/open > 0 (אין לנו close קודם בשלב זה — קירוב מספיק לסינון גס)
4. למיין לפי שינוי יומי יורד ולקחת עד `FUNNEL_STAGE2_SIZE` (ברירת מחדל 300).

**שלב 2 — היסטוריה מלאה + סינון מדויק:**
1. `getDailyBars({ symbols: survivors, days: 90 })`.
2. לכל סימול עם ≥21 bars לחשב מקומית (מהישן לחדש):
   - `price` = close אחרון; `previousClose` = close לפני אחרון
   - `daily_change` = ‏((close אחרון − previousClose)/previousClose)×100
   - `gap_pct` = ‏((open אחרון − previousClose)/previousClose)×100
   - `adr_pct` = ממוצע 20 ה-bars האחרונים של ‏((h−l)/l)×100
   - `volume` = v אחרון; `average_volume_30d` = ממוצע 30 אחרונים (או כמה שיש)
   - `volumeRatio` = volume/average_volume_30d
   - `high_52w` = max(h) על כל ה-bars שיש; `highProximity` = price/high_52w
3. סינון מלא (אותם ספים קיימים ב-watchlistService, לייבא — לא לשכפל):
   - `adr_pct ≥ MIN_ADR_PCT` (3)
   - `volumeRatio ≥ MIN_VOLUME_RATIO` (1.2)
   - `daily_change > 0`
   - **הערה:** אין market cap בשלב זה (Alpaca לא מחזירה) — הסינון לפי שווי שוק עובר לשלב 3.
4. דירוג לפי אותה נוסחה קיימת (normalize של daily_change/volumeRatio/highProximity במשקלים 0.4/0.35/0.25 — לייצא אותה מ-watchlistService ולעשות בה שימוש חוזר), ולקחת עד `FUNNEL_FINALISTS` (ברירת מחדל 20).

**שלב 3 — העשרת FMP לפינליסטים בלבד:**
1. לכל פינליסט: קריאת FMP‏ `profile` (שווי שוק + שם חברה) ו-earnings calendar (הפונקציה הקיימת `checkEarningsSoon` — לייצא אותה מ-watchlistService או להעביר למודול משותף).
2. סינון שווי שוק: `market_cap < MARKET_CAP_CEILING` (10B). אם ה-profile נכשל — **לא לפסול**; לסמן `market_cap: null` ולהשאיר (fail-soft), עם `reason` שמציין שאין נתון שווי שוק.
3. חיתוך סופי ל-`MAX_WATCHLIST_SIZE` (10).
4. פורמט פלט: **זהה** למבנה שהיום `enrichCandidate` מחזיר (ticker, companyName, price, daily_change, volumeRatio, adr_pct, highProximity, market_cap, rankScore, reason, hasEarningsSoon) + שדה חדש `dataSource: 'alpaca+fmp'`.

### 3.3 שינוי: `server/src/services/watchlistService.js`

ב-`buildTomorrowWatchlist`:
1. אם `funnelScanService.scanForGapAndGo({ exchange })` מחזיר מערך (גם ריק!) — זו התוצאה. מערך ריק פירושו "באמת אין מועמדים בשוק היום", וזה לגיטימי.
2. אם החזיר `null` (Alpaca לא מוגדר/נכשל) — המסלול הקיים בדיוק כמו היום (universe של FMP + הסינון הקיים). להוסיף `dataSource: 'fmp-universe'` לפריטים במסלול הזה.
3. אין שינוי ב-cache/scheduler — הם עוטפים את `buildTomorrowWatchlist` וייהנו מהשינוי אוטומטית.

### 3.4 שינוי: `server/src/routes/watchlist.js` + client

1. ה-route מחזיר גם `dataSource` (מהפריט הראשון או 'none' אם ריק).
2. ב-client (‏`App.jsx`): בפאנל הרשימה, ליד חותמת הזמן, להציג chip קטן: "מקור: סריקת שוק רחבה" כאשר `dataSource==='alpaca+fmp'`, או "מקור: מדגם מצומצם" אחרת — כדי שהמשתמש יידע אם הוא מקבל את המשפך המלא.

### 3.5 משתני סביבה חדשים

להוסיף ל-`.env.example` ולתעד ב-README:

```env
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
FUNNEL_MIN_PRICE=1
FUNNEL_MAX_PRICE=500
FUNNEL_MIN_DOLLAR_VOLUME=5000000
FUNNEL_STAGE2_SIZE=300
FUNNEL_FINALISTS=20
```

כל הספים נקראים עם ברירות מחדל בקוד; env הוא דריסה בלבד.

### 3.6 תיעוד

1. README: סעיף חדש "ארכיטקטורת משפך לנתונים" — התרשים משלב 0, טבלת הספקים ותפקידם, משתני הסביבה, והתנהגות ה-fallback. לעדכן את סעיף רשימת המעקב למחר בהתאם.
2. `docs/LOGIC_IMPROVEMENTS.md`: לסמן שסעיף ה-universe (5.3) קיבל מענה מלא עבור ה-watchlist, ולהוסיף סעיף 7.5 שמתאר את המשפך.
3. commit נפרד לתיעוד.

---

## 4. תוכנית טסטים (חובה)

קובץ חדש `server/test/alpacaService.test.js`:
1. `isConfigured` — false בלי מפתחות, true איתם.
2. `getDailyBars` מפצל 450 סימולים ל-3 קריאות (mock fetch סופר קריאות ובודק את פרמטר symbols).
3. `getDailyBars` עוקב אחרי `next_page_token` (mock שמחזיר שני עמודים) וממזג.
4. שגיאת HTTP (mock מחזיר 403) ⇒ מחזיר Map ריקה, לא זורק.

קובץ חדש `server/test/funnelScan.test.js` (mock מלא של alpacaService + fetch של FMP):
1. end-to-end: assets→bars→סינון→העשרה מחזיר מועמדים בפורמט הנכון, ממוינים לפי rankScore.
2. הסינון הגס מוריד מניה מתחת ל-dollar volume.
3. מניה עם ADR נמוך נפסלת בשלב 2.
4. פינליסט עם market cap של 50B נפסל בשלב 3; פינליסט עם profile שנכשל **נשאר** עם market_cap null.
5. `scanForGapAndGo` מחזיר null כשהמפתחות חסרים.

עדכון `server/test/watchlistService.test.js`:
6. כש-funnel מחזיר מערך — הוא התוצאה; כשמחזיר null — המסלול הישן רץ (הטסטים הקיימים ממשיכים לעבור כי אין מפתחות Alpaca בסביבת הטסט — לוודא ב-setup מחיקת `ALPACA_API_KEY_ID`).

---

## 5. קריטריוני קבלה

1. כל הטסטים (הקיימים + החדשים, ≥60 סה"כ) עוברים ב-`npm test`.
2. `npx vite build` עובר נקי.
3. בלי מפתחות Alpaca: התנהגות **זהה ביט-לביט** להיום (אותם מסלולים, אותו פלט).
4. עם מפתחות Alpaca (בדיקה ידנית של המשתמש): `GET /api/watchlist/tomorrow?exchange=NASDAQ&refresh=true` מחזיר מועמדים אמיתיים מסריקה רחבה, עם `dataSource: 'alpaca+fmp'`, בפחות מ-3 דקות.
5. צריכת FMP בכל הסריקה: ≤ ‏(2 × FUNNEL_FINALISTS) קריאות.
6. אין תלות npm חדשה; אין שינוי ב-`analyzeMarket` וב-pipeline של הסריקה הרגילה.

## 6. מחוץ לתחולה (לא לבצע)

- החלפת מקור הנתונים של `analyzeMarket` / האסטרטגיות — נשאר FMP.
- תמיכת Alpaca ב-TASE (אין — נשאר כמו היום).
- ספקים נוספים (Tiingo/Stooq) — רק להשאיר את המבנה מוכן (adapter נפרד).
- WebSocket / נתוני זמן אמת.

## 7. סדר ביצוע מומלץ (commits)

1. `alpacaService.js` + הטסטים שלו.
2. `funnelScanService.js` + הטסטים שלו (כולל ייצוא הספים/הדירוג/checkEarningsSoon ממודול משותף).
3. חיווט ל-`watchlistService` + route + client chip + עדכון טסטי watchlist.
4. env + תיעוד (README + LOGIC_IMPROVEMENTS).
5. `git push origin main`.

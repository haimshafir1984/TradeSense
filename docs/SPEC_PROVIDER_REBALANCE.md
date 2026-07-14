# מסמך איפיון: פיזור ספקי הנתונים — שחרור התלות במכסת FMP

תאריך: 2026-07-14
סטטוס: מאושר לביצוע
מבצע מיועד: סוכן קוד אוטונומי (Sonnet)

---

## 0. הבעיה (מאומתת בפועל)

מכסת ה-free tier של FMP היא **250 קריאות ליום**, וסריקה רגילה אחת שורפת
~160 מהן (4 קריאות פר-מניה × 40). בפועל המכסה נגמרת כמעט כל יום תוך
סריקה-שתיים (אומת: 429 "Limit Reach" על כל קריאה), ואז:
- ה-screener של `smallCapUniverseService` נכשל → אסטרטגיית
  `small_cap_breakout` לעולם לא מקבלת מאגר אמיתי → "אין סטאפים איכותיים"
  תמיד.
- המאגר הרגיל נופל לנתונים חלקיים/דמו.
- לוח הדוחות ושווי השוק בפינליסטים של ה-watchlist נכשלים.

בנוסף, FMP חינמי חוסם סימולים רבים גם כשיש מכסה ("Premium Query
Parameter" פר-סימול).

## 1. הפתרון — פיזור לפי סוג נתון, לא ספק יחיד

| סוג נתון | ספק חדש | מגבלה | הערות |
|---|---|---|---|
| מחירים + היסטוריה (bars) | **Alpaca** (קיים, עובד) | 200 קריאות/דקה, ללא מכסה יומית | כבר משמש את המשפך ואת ה-universe של small-cap |
| רשימות מניות + שווי שוק | **Nasdaq public API** (חדש) | ללא מפתח בכלל | ✅ אומת חי: `api.nasdaq.com/api/screener/stocks` החזיר 1,660 מניות small/micro ב-NASDAQ עם marketCap בקריאה אחת |
| דוחות קרובים + פונדמנטלס + סקטור | **Finnhub** (מפתח חינמי) | 60 קריאות/דקה, **ללא מכסה יומית** | קוד Finnhub חלקי כבר קיים ב-`marketDataService.js` |
| הכול (fallback אחרון) | FMP | 250/יום | יורד ממסלול קריטי ל-fallback בלבד |

עיקרון: **אף מסלול קריטי לא תלוי יותר במכסה יומית.** כל שרשרות ה-fallback
הקיימות נשמרות — בלי מפתח Finnhub או כשל Nasdaq, המערכת מתנהגת בדיוק
כמו היום.

## 2. עקרונות מחייבים

1. **אפס רגרסיה במסלולי ה-fallback.** בלי מפתחות Alpaca/Finnhub, ובכשל
   של Nasdaq API — ההתנהגות זהה ביט-לביט להיום (94 הטסטים הקיימים
   עוברים ללא שינוי בהתנהגות הנבדקת).
2. **כל ספק מאחורי adapter יחיד** — אסור fetch ישיר ל-Nasdaq/Finnhub
   מחוץ לקובץ ה-adapter שלו (אותו עיקרון כמו `alpacaService.js`).
3. **Fail-soft בכל שכבה:** כשל ספק = `console.warn` + נפילה לספק הבא
   בשרשרת. לעולם לא זורקים שגיאה למשתמש בגלל ספק בודד.
4. **Nasdaq API הוא לא-רשמי** (משרת את האתר שלהם) — חובה: header של
   user-agent דפדפני + accept: application/json; base URL ניתן לדריסה
   ב-env (`NASDAQ_API_BASE_URL`) לצורכי טסט; ותיעוד מפורש שהוא עלול
   להישבר יום אחד, עם fallback מלא ל-FMP screener.
5. אחרי כל שלב: `npm test` מ-`server/` (94 + חדשים), `npx vite build`
   מ-`client/` (נקי, למחוק `dist`). commits באנגלית; בסוף
   `git push origin main`.
6. טסטים: mock ל-`global.fetch` / monkey-patching של מודולים בלבד, בלי
   רשת אמיתית (הדפוס הקיים ב-`server/test/`). ב-setup למחוק את כל
   מפתחות ה-env הרלוונטיים כשבודקים fallback.

## 3. חלק א' — adapter חדש: `nasdaqService.js`

קובץ: `server/src/services/providers/nasdaqService.js`.

- Base URL: ‏`process.env.NASDAQ_API_BASE_URL || 'https://api.nasdaq.com'`.
- headers חובה בכל קריאה:
  `{ accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }`
  (בלעדיהם ה-API חוסם).
- throttle פשוט: מקסימום ~30 קריאות/דקה (אותו דפוס `requestTimestamps`
  כמו `alpacaService.js`) — זה API לא רשמי, עדינות חשובה.

פונקציות מיוצאות:

1. `getScreenerRows({ exchange, marketCapTiers, limit })` —
   `GET /api/screener/stocks?tableonly=true&limit={pageSize}&offset={offset}&exchange={exchange}`
   ואם `marketCapTiers` סופק (מערך מתוך `['mega','large','mid','small','micro','nano']`),
   מוסיפים `&marketcap={tiers.join('|')}`.
   - עמודי תוצאה: ‏`pageSize=200`; ממשיכים ב-offset עד `limit` הכולל או עד
     שאין שורות. ה-`totalrecords` שבתשובה קובע מתי לעצור.
   - נרמול כל שורה: ‏`symbol`, ‏`companyName` (מנקים סיומות "Common Stock"
     וכד' — `name.replace(/ (Common|Ordinary).*$/,'')` בקירוב), ‏
     `marketCap` (המחרוזת `"1,986,944,498"` → Number, פסיקים מוסרים; אם
     לא ניתן לפרסר → null), ‏`price` (‏`lastsale` בלי `$`), ‏
     `dailyChangePct` (‏`pctchange` בלי `%`).
   - לסנן סימולים עם `/` או `.` או `^` (וורנטים/בכורה).
   - כשל/תשובה לא-תקינה → `null` (לא לזרוק).
2. `isAvailable()` — פשוט `true` (אין מפתח); קיים לסימטריה עם שאר ה-adapters.

## 4. חלק ב' — adapter חדש: `finnhubService.js`

קובץ: `server/src/services/providers/finnhubService.js`. משתמש ב-
`FINNHUB_API_KEY` (כבר נתמך ב-env של הפרויקט מהעבר).

- `isConfigured()` — יש מפתח.
- throttle: ‏50 קריאות/דקה (מרווח בטחון מתחת ל-60).
- `getEarningsSoon(ticker, lookaheadDays)` —
  `GET /api/v1/calendar/earnings?from={today}&to={today+lookaheadDays}&symbol={ticker}&token=...`
  → ‏true אם ‏`earningsCalendar` מכיל רשומה שה-symbol שלה **תואם בפועל**
  ל-ticker (לא לסמוך על הסינון של הצד השני — הלקח מ-FMP). כשל → null
  (לא false! — ‏null מסמן "לא ידוע", כדי שה-caller יוכל ליפול ל-FMP).
- `getCompanyProfile(ticker)` —
  `GET /api/v1/stock/profile2?symbol={ticker}&token=...`
  → ‏`{ companyName, sector, marketCap }` (‏`marketCapitalization` הוא
  **במיליוני דולרים** — להכפיל ב-1,000,000; זה כבר ידוע מהקוד הקיים
  ב-`marketDataService.js`). כשל → null.

## 5. חלק ג' — חיווט לפי subsystem

### 5.1 `smallCapUniverseService.js` — שלב 1 עובר ל-Nasdaq

`fetchScreenerCandidates` מנסה כעת קודם:
`nasdaqService.getScreenerRows({ exchange, marketCapTiers: ['small','micro'], limit: SMALL_CAP_UNIVERSE_SIZE })`
עם סינון מקומי נוסף לפי `SMALL_CAP_THRESHOLDS` (מחיר ≥ minPrice; שווי
שוק < ceiling — ה-tiers של Nasdaq קרובים אבל לא זהים להגדרה שלנו, אז
הסף שלנו הוא הקובע). אם Nasdaq החזיר `null`/ריק → נופל ל-FMP screener
הקיים בדיוק כמו היום. שאר הפונקציה (Alpaca bars וכו') ללא שינוי.

### 5.2 `funnelScanService.js` — שלב 3 (שווי שוק + דוחות)

`enrichWithFmp` הופך ל-`enrichCandidate` עם שרשרת:
1. שווי שוק: ‏`finnhubService.getCompanyProfile` (אם מוגדר) → אם נכשל/אין
   מפתח → ‏FMP profile הקיים → אם נכשל → ‏null (כמו היום).
2. דוחות: ‏`finnhubService.getEarningsSoon` (אם מוגדר, ותשובה לא-null)
   → אחרת ‏`checkEarningsSoon` הקיים של FMP → אחרת false.

### 5.3 `watchlistService.js` (מסלול ה-fallback הישן) — אותו שינוי דוחות

השורה `hasEarningsSoon: apiKey ? await checkEarningsSoon(...)` עוברת
לאותה שרשרת Finnhub→FMP. כדי לא לשכפל, להוציא את השרשרת לפונקציה
משותפת אחת (למשל `resolveEarningsSoon(ticker)` ב-`watchlistScoring.js`,
שמכילה את סדר הנפילה במקום אחד).

### 5.4 `marketDataService.getMarketData` — המאגר הרגיל עובר ל-Alpaca

זה השינוי הגדול, והוא מחסל את בעיית ~160 הקריאות:

מסלול חדש (ראשון בסדר העדיפויות), בתנאי ש-`alpacaService.isConfigured()`:
1. רשימת מניות: ‏`nasdaqService.getScreenerRows({ exchange, limit: FMP_UNIVERSE_SIZE })`
   (בלי סינון tiers — לוקחים את השורות הראשונות; ה-API מחזיר ממוין לפי
   שווי שוק יורד, כך שזה שקול ל"המניות הגדולות/נזילות") → אם `null` →
   מדלגים על המסלול החדש כולו ונופלים ל-FMP הקיים.
2. נתונים טכניים: ‏Alpaca bars ‏(420 יום) לכל הרשימה ב-batch — **לעשות
   שימוש חוזר ב-builder הקיים** של `smallCapUniverseService.buildStockFromBars`
   (להוציא אותו למודול משותף, למשל
   `server/src/services/barsStockBuilder.js`, כדי ששני המסלולים לא
   ישתכפלו): כל השדות באותם שמות/הגדרות בדיוק.
3. פונדמנטלס: אם ‏`finnhubService.isConfigured()` — ‏`getCompanyProfile`
   ל-sector (החלפת ה-'Unknown') — **בלי** לחסום את הסריקה: best-effort
   מקבילי מוגבל (עד ~10 בקשות במקביל), כשל = משאירים imputed. ‏
   `revenue_growth_pct` נשאר 0+imputed במסלול הזה (מקובל: רק
   micha_stocks משתמשת בו, וה-tradeoff מתועד).
4. ‏`source` חדש: ‏`'alpaca+nasdaq'`. ‏`sourceLabel` ב-client מקבל תווית:
   "נתוני אמת (Alpaca+Nasdaq)" עם class ‏'live'.
5. TASE לא נתמך במסלול החדש (Alpaca לא מכסה) — ממשיך ישירות למסלול
   הקיים, ללא שינוי.

**חשוב:** ה-cache הקיים (`MARKET_DATA_CACHE`) עוטף גם את המסלול החדש,
באותו TTL.

### 5.5 `marketDataService.getStockSnapshot` — snapshot בודד עובר ל-Alpaca

משמש את SPY/QQQ/IWM (מדדי ייחוס), את הערכת ההיסטוריה
(`scanHistoryService`), ואת התיק (`portfolioService`). מסלול חדש ראשון,
בתנאי ש-Alpaca מוגדר:
1. ‏Alpaca bars לסימול (420 יום) → ‏`buildStockFromBars` (שם/סקטור:
   ‏Finnhub profile best-effort אם מוגדר; אחרת ticker + 'Unknown' +
   imputed).
2. אם ל-Alpaca אין bars לסימול (למשל טיקר עברי שגוי) → המסלול הקיים
   (FMP → דמו) בדיוק כמו היום.
ה-`SNAPSHOT_CACHE` הקיים ממשיך לעטוף הכול.

הערה: ‏SPY/QQQ/IWM הם ETF-ים — ‏Alpaca IEX מכסה אותם; אין צורך בטיפול
מיוחד.

## 6. טסטים (חובה)

`server/test/nasdaqService.test.js`:
1. פרסינג: שורת דוגמה אמיתית (marketCap עם פסיקים, lastsale עם $,
   pctchange עם %) → מספרים נכונים.
2. pagination: ‏totalrecords גדול מ-pageSize → קריאות עוקבות עם offset,
   מיזוג נכון, עצירה ב-limit.
3. סינון סימולים עם `.`/`/`/`^`.
4. כשל HTTP → ‏null, לא זריקה.

`server/test/finnhubService.test.js`:
5. ‏getEarningsSoon: תואם-סימול → true; רשומות של סימולים אחרים בלבד →
   false; כשל HTTP → **null** (לא false).
6. ‏getCompanyProfile: ‏marketCapitalization במיליונים → מוכפל נכון; כשל →
   null.
7. בלי מפתח: ‏isConfigured()===false ושתי הפונקציות מחזירות null בלי
   לקרוא ל-fetch.

`server/test/providerRebalance.test.js` (אינטגרציה):
8. ‏getMarketData במסלול החדש: ‏Nasdaq mock + Alpaca mock → ‏stocks עם
   ‏source==='alpaca+nasdaq' וכל שדות הטכני מחושבים.
9. ‏Nasdaq mock מחזיר null → ‏getMarketData נופל למסלול FMP הקיים (לוודא
   שה-fetch של FMP נקרא).
10. ‏smallCapUniverseService עם Nasdaq mock → ה-screener של FMP **לא**
    נקרא; עם Nasdaq null → כן נקרא (fallback).
11. שרשרת הדוחות: ‏Finnhub עונה → ‏FMP לא נקרא; ‏Finnhub מחזיר null → ‏FMP
    נקרא.
12. ‏getStockSnapshot: ‏Alpaca עם bars → לא קוראים ל-FMP; בלי bars → כן.

עדכון טסטים קיימים: טסטים שבודקים את מסלול ה-FMP הרגיל צריכים למחוק
גם `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`/`FINNHUB_API_KEY` ב-setup
(חלקם כבר עושים זאת).

## 7. תיעוד

- README: עדכון "שכבת הנתונים" + "ארכיטקטורת משפך" לטבלת הספקים
  החדשה; ‏source חדש ‏`alpaca+nasdaq` ברשימת הערכים; משתני env חדשים
  (`FINNHUB_API_KEY` חוזר לשימוש פעיל, `NASDAQ_API_BASE_URL` לטסטים);
  אזהרת "Nasdaq API לא רשמי" מפורשת.
- `docs/LOGIC_IMPROVEMENTS.md`: סעיף 7.7 קצר — הבעיה (מכסת FMP),
  הפיזור, וה-fallbacks.
- `docs/DEPLOYMENT.md`: להוסיף את `FINNHUB_API_KEY` לרשימת משתני
  הסביבה שצריך להגדיר ב-Render.
- `.env.example`: להוסיף `FINNHUB_API_KEY=` (אם אינו שם) — בלי ערכים.

## 8. קריטריוני קבלה

1. כל הטסטים (94 + חדשים) עוברים; build נקי.
2. **בלי אף מפתח חדש** (רק FMP): התנהגות זהה להיום — כל הטסטים הקיימים
   מוכיחים זאת.
3. עם Alpaca בלבד (המצב הנוכחי בפועל): המאגר הרגיל וה-small-cap
   universe עובדים **בלי אף קריאת FMP** במסלול המרכזי; screener נופל
   ל-FMP רק אם Nasdaq נכשל.
4. עם Alpaca+Finnhub: גם דוחות/סקטור/שווי שוק בלי FMP.
5. סריקה רגילה מלאה (קרה) צורכת **0 קריאות FMP** במסלול החדש.
6. `small_cap_breakout` מחזירה מאגר אמיתי של מניות קטנות (מ-Nasdaq)
   גם כשמכסת FMP מוצתה.
7. כשל מוחלט של Nasdaq API (למשל חסימה עתידית) לא מפיל שום דבר —
   רק חוזרים להתנהגות של היום.

## 9. סדר ביצוע (commits)

1. `nasdaqService.js` + טסטים.
2. `finnhubService.js` + טסטים.
3. הוצאת `buildStockFromBars` למודול משותף (`barsStockBuilder.js`) +
   חיווט `smallCapUniverseService` ל-Nasdaq (עם fallback ל-FMP) + טסטים.
4. חיווט `getMarketData`/`getStockSnapshot` למסלול Alpaca+Nasdaq +
   שרשרת הדוחות Finnhub→FMP + טסטי אינטגרציה + תווית source ב-client.
5. תיעוד (README, LOGIC_IMPROVEMENTS 7.7, DEPLOYMENT, .env.example) —
   commit נפרד.

## 10. מה המשתמש צריך לעשות (לא חלק מעבודת הסוכן)

**לפני או אחרי המימוש — לא חוסם את הקוד:**
1. לפתוח מפתח חינמי ב-https://finnhub.io (הרשמה בלי כרטיס אשראי,
   המפתח מופיע מיד בדשבורד).
2. להוסיף ל-`.env` המקומי: ‏`FINNHUB_API_KEY=המפתח`.
3. להוסיף ב-Render (שירות ה-Backend בלבד) → Environment →
   ‏`FINNHUB_API_KEY` עם אותו ערך. השמירה תגרום ל-redeploy אוטומטי.

**אחרי שהמימוש נדחף ל-main (deploy אוטומטי):**
4. לוודא בטאב "סריקת שוק": badge מקור הנתונים אמור להציג את המקור
   החדש (Alpaca+Nasdaq) במקום FMP.
5. להריץ סריקת `small_cap_breakout` — אמורות להופיע מניות קטנות
   אמיתיות (אם השוק לא בירידה חדה באותו יום).
6. בלי מפתח Finnhub הכול עדיין עובד — רק "דוח בקרוב"/סקטור עשויים
   ליפול ל-FMP (שעלול להיות ממוצה) או להישאר ריקים.

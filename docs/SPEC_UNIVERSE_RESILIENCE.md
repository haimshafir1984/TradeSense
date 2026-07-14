# מסמך איפיון: Universe עמיד — שחרור התלות בסקרינר של Nasdaq בזמן ריצה

תאריך: 2026-07-14
סטטוס: מאושר לביצוע
מבצע מיועד: סוכן קוד אוטונומי (Sonnet)
מסמך קודם בשרשרת: `docs/SPEC_PROVIDER_REBALANCE.md`

---

## 0. הבעיה (מאומתת בפועל, מלוגי Render)

ה-rebalance הקודם העביר את רשימות המניות + שווי השוק לסקרינר הציבורי של
Nasdaq (`api.nasdaq.com`). **מקומית זה עובד; מ-Render זה נכשל.** לוג
production מ-2026-07-14 08:49 מראה סריקת `small_cap_breakout` שהשלימה עם
`source: 'alpaca+fmp-screener'` — כלומר `nasdaqService.getScreenerRows`
החזיר null והמערכת נפלה ל-FMP screener. FMP חזר להיות על המסלול הקריטי,
ומכסת ה-250 קריאות/יום שלו תחזור להיגמר.

הסיבה: `api.nasdaq.com` יושב מאחורי Akamai שמסנן לפי טביעת אצבע של
הלקוח — כתובת IP (טווחי datacenter כמו של Render נחסמים), TLS
fingerprint (Node/undici נראה שונה מדפדפן), ו-headers. זו לא בעיה
שאפשר "לתקן" אמינות מהצד שלנו: כל עקיפה (proxy, זיוף fingerprint)
שבירה מיסודה ועלולה להפסיק לעבוד בכל רגע.

## 1. העיקרון הפותר

**להפסיק להזדקק לסקרינר אנונימי בזמן ריצה.** את שני הנתונים ש-Nasdaq
סיפק אפשר להרכיב מספקים שכבר מוכחים כעובדים מ-Render:

| נתון | מקור | הערה |
|---|---|---|
| רשימת כל המניות בבורסה | Alpaca `GET /v2/assets` | כבר בשימוש (שלב 1 של המשפך) — עובד מ-Render |
| מחיר / נפח / נפח דולרי | Alpaca bars (batch) | כבר בשימוש — עובד מ-Render |
| שווי שוק פר-סימול | Finnhub `stock/profile2` | האדפטר כבר קיים (`finnhubService.getCompanyProfile`); 60 קריאות/דקה, **ללא מכסה יומית**; המפתח כבר מוגדר ב-Render (אומת בלוג: `FINNHUB_API_KEY=present`) |

הקושי היחיד: אי אפשר לשאול את Finnhub שווי שוק על ~5,500 סימולים בכל
סריקה. הפתרון בנוי משלושה רכיבים:

1. **צמצום לפני העשרה:** מ-Alpaca בלבד (רשימת נכסים + latest bars)
   מסננים מקומית לפי מחיר ונפח דולרי — בדיוק הפילטרים ששאילתת ה-screener
   הישנה עשתה בצד השרת. נשארים ~300–500 מועמדים סחירים. רק עליהם
   שואלים Finnhub שווי שוק.
2. **חישוב בלילה, לא בזמן סריקה:** ה-scheduler הקיים
   (`watchlistScheduler.js`) כבר רץ כל ערב. מוסיפים לו משימה שבונה את
   ה-universe ושומרת אותו לקובץ בדיסק המתמיד (`/var/data`). סריקות ביום
   קוראות מהקובץ — מהירות, דטרמיניסטיות, אפס קריאות רשת לרשימה.
3. **Last-known-good:** הקובץ בדיסק לא נמחק כשריענון נכשל. אם כל
   הספקים נופלים, סריקה משתמשת ב-universe של אתמול (עם ציון גיל הנתונים
   ב-`dataQuality.issues`) — **נתון אמיתי ישן עדיף על נתוני דמו**.

Nasdaq API **לא נמחק** — הוא נשאר ראשון בשרשרת הרענון (זול, קריאה אחת,
עובד מצוין בסביבה מקומית). פשוט המערכת כבר לא תלויה בו.

## 2. עקרונות מחייבים

1. **אפס רגרסיה.** כל 111 הטסטים הקיימים עוברים ללא שינוי בהתנהגות
   הנבדקת. בלי מפתחות Alpaca — התנהגות זהה להיום (fallback ל-FMP/דמו).
2. **כל fetch דרך אדפטר קיים.** אסור fetch חדש ישיר — משתמשים רק
   ב-`alpacaService`, `finnhubService`, `nasdaqService`, `fetchJson`.
3. **Fail-soft בכל שכבה.** כשל = `console.warn` + נפילה לשלב הבא. אף
   ספק לא מפיל סריקה.
4. **דפוס ה-store הקיים.** הקובץ החדש בדיסק עוקב אחרי אותו דפוס כמו
   `watchlistStore.js`/`portfolioService` — נתיב override ב-env
   (`UNIVERSE_STORE_FILE_PATH`), ברירת מחדל תחת אותה תיקייה כמו שאר
   ה-stores, כתיבה אטומית ככל שהדפוס הקיים עושה.
5. אחרי כל שלב: `npm test` מ-`server/`, `npx vite build` מ-`client/`
   (ולמחוק `dist`). בסוף `git push origin main` ודיווח מול סעיף 8.
6. טסטים: mock ל-`global.fetch` / monkey-patching של מודולים, קבצי
   scratch לנתיבי store (הדפוס הקיים ב-`server/test/`).

## 3. שלב 0 — אבחון ועמידות באדפטר Nasdaq (לפני הכול)

לפני שינוי ארכיטקטוני, לחזק את `nasdaqService.js` כדי שנדע בדיוק למה
הוא נכשל מ-Render, ושלא ייתקע:

1. **Timeout מפורש:** ל-fetch אין timeout כיום. Akamai לפעמים לא מחזיר
   כלום ומחזיק את החיבור פתוח — להוסיף `AbortController` עם ~10 שניות,
   שנכשל רך (מחזיר null) עם `console.warn` שמציין timeout.
2. **לוג אבחוני מפורט בכשל:** status code, האם timeout, ו-50 התווים
   הראשונים של גוף התשובה (Akamai מחזיר לפעמים HTML של חסימה עם 200).
   אם התשובה היא 200 אבל לא JSON תקין — לוג מפורש "non-JSON response
   (likely bot-blocked)".
3. **Headers דפדפניים מלאים (ניסיון זול, לא מובטח):** להוסיף
   `accept-language: en-US,en;q=0.9`, `referer: https://www.nasdaq.com/market-activity/stocks/screener`,
   `origin: https://www.nasdaq.com`. לפעמים זה מספיק ל-Akamai; אם לא —
   לא נורא, השרשרת החדשה מכסה.

אלה שינויים באדפטר בלבד; הטסטים הקיימים שלו ממשיכים לעבור (ה-mock של
fetch לא מושפע מ-AbortController אם מממשים נכון — ה-signal פשוט מועבר).

## 4. הרכיב המרכזי — `universeStore.js` + בניית universe לילית

### 4.1 קובץ חדש: `server/src/services/universeStore.js`

אחסון JSON בדיסק (דפוס `watchlistStore.js`). מבנה לוגי של התוכן:

- מפתח לפי בורסה (`NASDAQ`, `NYSE`).
- לכל בורסה: `generatedAt` (ISO), `source` (מחרוזת — מי סיפק את
  הרשימה: `nasdaq` / `alpaca+finnhub` / `fmp`), ומערך שורות
  `{ symbol, companyName, sector, marketCap, price, avgDollarVolume }`.
- פונקציות: קריאה, כתיבה, ושאילתה עם מדיניות טריות (ראו 4.3).
- נתיב: `UNIVERSE_STORE_FILE_PATH` ב-env, ברירת מחדל לצד שאר ה-stores
  (ב-Render: תחת `/var/data`).

### 4.2 קובץ חדש: `server/src/services/universeBuilderService.js`

פונקציה מרכזית `refreshUniverse({ exchange })` שמריצה שרשרת ניסיונות
ושומרת את התוצאה המוצלחת הראשונה ל-`universeStore`:

**ניסיון א' — Nasdaq (קיים):** `nasdaqService.getScreenerRows` כמו
היום. מצליח → שומרים עם `source: 'nasdaq'`. (מקומית זה יעבוד; ב-Render
כנראה ייכשל וימשיך הלאה.)

**ניסיון ב' — Alpaca+Finnhub (החדש, העיקרי ב-production):**
1. `alpacaService.getActiveAssets({ exchange })` — כל הנכסים הפעילים
   (כ-5,500 ב-NASDAQ). סינון סימולים עם `/`, `.`, `^` (קיים כבר בדפוס).
2. `alpacaService.getLatestDailyBars({ symbols })` — bar אחרון לכולם
   (batch, הדפוס הקיים של שלב 1 במשפך).
3. סינון מקומי: מחיר בטווח סביר (להשתמש באותם ספים שכבר קיימים —
   `SMALL_CAP_THRESHOLDS.minPrice` כרצפה; תקרה לא נחוצה כאן), נפח
   דולרי מינימלי (סף חדש, env: `UNIVERSE_MIN_DOLLAR_VOLUME`, ברירת
   מחדל 2,000,000$ — נמוך מספיק כדי לא לפספס small-caps נפיצות, גבוה
   מספיק כדי לרדת לכמה מאות מועמדים). מיון לפי נפח דולרי יורד וקיטום
   ל-`UNIVERSE_ENRICH_LIMIT` (env, ברירת מחדל 400).
4. העשרת שווי שוק: `finnhubService.getCompanyProfile` לכל מועמד,
   במקביליות מוגבלת (~המקביליות הקיימת ב-`enrichSectorsWithFinnhub`).
   ה-throttle של האדפטר (50/דקה) כבר מטפל בקצב — 400 סימולים ≈ 8
   דקות. **זה רץ בלילה, לא בסריקה — הזמן לא מפריע.**
   - אופטימיזציה מתבקשת: אם ב-store הקיים יש כבר שווי שוק לסימול
     שעודכן לפני פחות מ-7 ימים — לא שואלים שוב (שווי שוק לא קופץ
     מדרגה בשבוע). בהרצות עוקבות רוב הסימולים כבר מוכרים והריצה
     מתקצרת דרמטית.
   - מועמד שהעשרתו נכשלה נשמר עם `marketCap: null` (לא נזרק — הוא
     עדיין שמיש למאגר הרגיל, רק לא לסינון לפי שווי שוק).
5. שומרים עם `source: 'alpaca+finnhub'`.

**ניסיון ג' — FMP screener (קיים):** הקריאה הקיימת
(`fetchFmpCandidates` שב-`smallCapUniverseService`, מוכללת לכל
universe). מצליח → `source: 'fmp'`.

**הכול נכשל:** לא כותבים כלום — הקובץ הקיים בדיסק נשאר (last-known-good).

### 4.3 מדיניות טריות בקריאה

`universeStore` מחזיר לצרכן גם את גיל הנתונים. מדיניות:

- גיל < 24 שעות → תקין, שקוף למשתמש.
- גיל 24–72 שעות → שמיש, אבל מוסיפים ל-`dataQuality.issues` הודעה:
  "רשימת המניות מבוססת על סריקת אתמול/שלשום (רענון לילי נכשל)".
  (סופי שבוע לא נספרים כבעיה — bars של יום שישי הם הנתון הנכון ביום
  ראשון; ההודעה נחוצה רק כשחל יום מסחר בין לבין. אם ההבחנה מסובכת —
  ספירת שעות פשוטה עם סף 72 מקובלת כפשרה.)
- גיל > 72 שעות או אין קובץ → מתייחסים כאל "אין universe" וממשיכים
  בשרשרת הקיימת (ניסיון רענון סינכרוני מיידי → FMP → דמו).

### 4.4 תזמון

- `watchlistScheduler.js` מקבל משימה נוספת: אחרי רענון ה-watchlist
  הלילי, להריץ `refreshUniverse` לכל בורסה ב-`WATCHLIST_SCHEDULE_EXCHANGES`.
  (אותו מנגנון "פעם ביום אחרי שעה X" קיים — לא ממציאים תזמון חדש.)
- **רענון עצל בנוסף לתזמון:** אם סריקה מגיעה וה-universe בן יותר מ-24
  שעות (או חסר), מפעילים `refreshUniverse` — אבל לא מחכים לו אם יש
  last-known-good שמיש (מחזירים את הישן מיד, הרענון מתעדכן ברקע
  לסריקה הבאה). אם אין בכלל קובץ (התקנה טרייה) — כן מחכים, כי
  האלטרנטיבה היא דמו. חשוב ב-Render: השירות עלול להירדם/להתאתחל בלילה
  ולפספס את התזמון.

## 5. חיווט הצרכנים

### 5.1 `smallCapUniverseService.js`

`fetchScreenerCandidates` מפסיק לקרוא ל-Nasdaq/FMP ישירות ובמקום זה:
1. שואל את `universeStore` (דרך ה-builder) את שורות הבורסה, מסנן לפי
   `SMALL_CAP_THRESHOLDS` (תקרת שווי שוק, רצפת מחיר) — בדיוק הסינון
   שהיה בשאילתת ה-screener. שורות עם `marketCap: null` לא עוברות את
   סינון ה-small-cap (אי אפשר לאשר שהן small).
2. אין universe שמיש → השרשרת הישנה כ-fallback (Nasdaq ישיר → FMP
   ישיר), ללא שינוי — זה מבטיח אפס רגרסיה בטסטים הקיימים.
- שאר הזרימה (bars מ-Alpaca, `buildStockFromBars`) ללא שינוי.
- `data_source` פר-מניה נגזר מ-`source` של ה-universe:
  `'alpaca+nasdaq'` / `'alpaca+finnhub'` / `'alpaca+fmp-screener'`.

### 5.2 `marketDataService.getMarketData` (מסלול Alpaca+Nasdaq מהמסמך הקודם)

`getAlpacaNasdaqMarketData` מפסיק לקרוא ל-`nasdaqService` ישירות
ובמקום זה לוקח את `DYNAMIC_UNIVERSE_SIZE` השורות המובילות (לפי שווי
שוק יורד; שורות בלי שווי שוק ממוינות לפי נפח דולרי אחריהן) מה-store.
שאר הזרימה (bars, `buildStockFromBars`, העשרת סקטור) ללא שינוי.
`source` של התוצאה: `'alpaca+' + universeSource` (כלומר גם
`'alpaca+finnhub'` אפשרי) — ולעדכן את `sourceLabel`/`sourceClassName`
ב-`App.jsx` בהתאם (class ‏`live`).

### 5.3 מה לא נוגעים

- המשפך של ה-watchlist (`funnelScanService`) — יש לו כבר את שלב 1 שלו
  מ-Alpaca ישירות; לא תלוי בסקרינר. ללא שינוי.
- `getStockSnapshot` — סימול בודד, לא צריך רשימה. ללא שינוי.
- TASE — ללא שינוי (לא מכוסה ע"י אף אחד מהספקים החדשים).

## 6. טסטים נדרשים (מינימום)

`server/test/universeBuilder.test.js` (חדש):
1. שרשרת הרענון: Nasdaq נכשל → Alpaca+Finnhub נבנה ונשמר עם
   `source: 'alpaca+finnhub'` (mock לשני האדפטרים).
2. סינון הנפח הדולרי והקיטום ל-`UNIVERSE_ENRICH_LIMIT` עובדים על
   נתוני bars מבוקרים.
3. שווי שוק טרי (בן פחות מ-7 ימים ב-store) לא גורר קריאת Finnhub
   נוספת; ישן כן.
4. כשל כולל של כל השרשרת לא דורס קובץ קיים (last-known-good נשמר).
5. מועמד עם כשל העשרה נשמר עם `marketCap: null` ולא מפיל את השאר.

`server/test/universeStore.test.js` (חדש):
6. כתיבה/קריאה round-trip עם נתיב scratch (דפוס `WATCHLIST_STORE_FILE_PATH`).
7. מדיניות הטריות: < 24 שעות תקין; 24–72 מחזיר דגל staleness; > 72
   נחשב חסר.

עדכוני טסטים קיימים:
8. `smallCapUniverse.test.js` — הוספת מקרה: universe זמין ב-store →
   אין שום קריאת רשת לרשימה (רק bars); ה-fallback הישיר הקיים ממשיך
   לעבור ללא שינוי כשה-store ריק.
9. `providerRebalance.test.js` — עדכון בהתאם לחיווט החדש של
   `getAlpacaNasdaqMarketData` (ה-assertions על "אפס קריאות FMP"
   נשמרות).
10. `nasdaqService.test.js` — טסט timeout חדש (fetch שנתקע → null
    אחרי ה-abort, עם mock ל-timer או timeout קצר ב-env).

## 7. תיעוד

- README: עדכון סעיף "שכבת הנתונים" — ה-universe נבנה בלילה ונשמר
  בדיסק; טבלת ספקים מעודכנת; ערכי `source` חדשים; משתני env חדשים
  (`UNIVERSE_STORE_FILE_PATH`, `UNIVERSE_MIN_DOLLAR_VOLUME`,
  `UNIVERSE_ENRICH_LIMIT`).
- `docs/LOGIC_IMPROVEMENTS.md` — סעיף 7.8: הבעיה (Akamai חוסם
  datacenter IPs), העיקרון (לא תלויים בסקרינר אנונימי בזמן ריצה),
  ו-last-known-good.
- `docs/DEPLOYMENT.md` — לציין שהקובץ החדש יושב על ה-Persistent Disk
  (נתיב תחת `/var/data`, כמו שאר ה-stores) ושכדאי לוודא
  `UNIVERSE_STORE_FILE_PATH` ב-env של Render.
- `.env.example` — המשתנים החדשים.

## 8. קריטריוני קבלה

1. כל הטסטים עוברים (111 קיימים + החדשים), `vite build` נקי.
2. ב-Render (Nasdaq חסום): הרענון הלילי בונה universe מ-Alpaca+Finnhub;
   סריקות `small_cap_breakout` וסריקות רגילות מציגות מקור נתונים חי
   (לא דמו, לא FMP על המסלול הקריטי) — אפס קריאות FMP בסריקה כשיש
   universe שמיש בדיסק.
3. מקומית (Nasdaq זמין): הרענון משתמש ב-Nasdaq (קריאה אחת) והתוצאה
   זהה פונקציונלית.
4. כשל רענון מוחלט: הסריקה משתמשת ב-universe של אתמול עם הודעת
   staleness ב-`dataQuality.issues`; אין קובץ בכלל → ההתנהגות של היום
   (FMP → דמו), ללא רגרסיה.
5. בלי מפתחות Alpaca: התנהגות זהה ביט-לביט להיום.
6. סריקה חוזרת באותו יום לא מפעילה שום קריאת רשת לרשימת המניות
   (קוראת מהדיסק).
7. אדפטר Nasdaq לא נתקע לעולם (timeout) ומדווח בלוג סיבת כשל ברורה.

## 9. סדר ביצוע (commits)

1. שלב 0: חיזוק `nasdaqService.js` (timeout, לוג אבחוני, headers) +
   טסט timeout.
2. `universeStore.js` + טסטים שלו.
3. `universeBuilderService.js` (שרשרת הרענון המלאה) + טסטים שלו.
4. חיווט הצרכנים (`smallCapUniverseService`, `getAlpacaNasdaqMarketData`,
   scheduler, רענון עצל) + עדכון טסטים קיימים + תוויות ב-`App.jsx`.
5. תיעוד (README, LOGIC_IMPROVEMENTS 7.8, DEPLOYMENT, .env.example).

אחרי כל שלב: `npm test` + `npx vite build` (ומחיקת `dist`); בסוף
`git push origin main` ודיווח מול סעיף 8.

## 10. מה המשתמש צריך לעשות

1. **כלום בצד המפתחות** — הכול כבר מוגדר ב-Render (Alpaca + Finnhub
   אומתו כ-present בלוגים).
2. אחרי הפריסה: להריץ סריקת `small_cap_breakout` פעם אחת (זה יפעיל
   את הרענון העצל הראשון — ייקח כמה דקות בפעם הראשונה, חד-פעמי),
   ואז סריקה שנייה ולוודא שהמקור המוצג הוא נתוני אמת ולא דמו.
3. אופציונלי: לבדוק בלוגי Render את שורות `[universe]` כדי לראות איזה
   מקור נבחר (`nasdaq` / `alpaca+finnhub` / `fmp`) ואת שורת האבחון של
   כשל ה-Nasdaq (סטטוס/timeout) — מעניין לתעד למה בדיוק Akamai חוסם.

# מסמך איפיון: אסטרטגיה חמישית — "מניות קטנות נפיצות" (small_cap_breakout)

תאריך: 2026-07-10
סטטוס: מאושר לביצוע
מבצע מיועד: סוכן קוד אוטונומי (Sonnet)

---

## 0. הרציונל

ארבע האסטרטגיות הקיימות רצות על universe של עד 40 מניות מ-FMP, שנוטה
לענקיות שוק (Amazon, Texas Instruments...). מניות כאלה עולות באחוזים
בודדים; המשתמש מנהל תיק בדיקה קטן ורוצה מסלול שמאתר **מניות קטנות עם
פוטנציאל תנועה של עשרות אחוזים** — פרופיל שקיים היום רק ב"רשימת המעקב
למחר" (המשפך), אבל לא כאסטרטגיה מלאה בטאב הסריקה עם ניקוד/ליגה/מעקב.

שני חלקים בלתי-נפרדים:
1. **לוגיקת ניקוד חדשה** לפרופיל small-cap נפיץ.
2. **universe ייעודי לאסטרטגיה הזו** — בלי זה האסטרטגיה חסרת ערך, כי
   במאגר של 40 ענקיות אין בכלל מניות קטנות למצוא.

זהו מימוש של "universe דינמי פר-אסטרטגיה" שסומן בעבר כמחוץ לתחולה
(docs/SPEC_DATA_FUNNEL.md סעיף 6) — התשתית (alpacaService) כבר קיימת.

## 1. עקרונות מחייבים

1. **אפס רגרסיה לארבע האסטרטגיות הקיימות.** כשבוחרים כל אסטרטגיה אחרת,
   ההתנהגות זהה ביט-לביט להיום. כל 70 הטסטים הקיימים ממשיכים לעבור.
2. **בלי שמות סוחרים אמיתיים** — תווית בסגנון תיאורי בלבד: "מניות קטנות
   נפיצות (Small-Cap)".
3. **Fail-soft:** אם Alpaca לא מוגדר או ה-universe הייעודי נכשל —
   האסטרטגיה רצה על ה-universe הרגיל (ענקיות), פילטר הכשירות שלה יפסול
   כמעט הכול, והמשתמש יקבל "אין סטאפים איכותיים" + הערה שמסבירה למה
   (ראו 4.3). אסור לזרוק שגיאה.
4. **אין להזין את אותו סיגנל גולמי פעמיים לציון אחד** (עקרון 3.1
   הקיים).
5. אחרי כל שלב: `npm test` מ-`server/` (70 + חדשים), `npx vite build`
   מ-`client/` (נקי, למחוק `dist`). commits באנגלית; בסוף
   `git push origin main`.
6. טסטים: mock ל-`global.fetch` ו-monkey-patching של מודולים בלבד
   (הדפוס הקיים ב-`server/test/`); בלי רשת אמיתית; ב-setup למחוק
   `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` כשבודקים fallback.

## 2. חלק א' — universe ייעודי: `getSmallCapUniverse`

קובץ חדש: `server/src/services/smallCapUniverseService.js`.

פונקציה מרכזית: `getSmallCapUniverse({ exchange }) → Promise<stocks[] | null>`.
מחזירה `null` אם Alpaca לא מוגדר (`alpacaService.isConfigured()===false`)
או אם אחד השלבים נכשל/ריק — הסימן ל-caller ליפול ל-universe הרגיל.

### 2.1 שלב 1: רשימת מועמדים + שווי שוק מ-FMP screener (קריאה אחת)

ה-screener הקיים (`stable/company-screener`) תומך בפרמטרים נוספים —
לקרוא לו עם:
```
exchange={exchange}&isActivelyTrading=true
&marketCapLowerThan=2000000000
&priceMoreThan=2
&volumeMoreThan=300000
&limit={SMALL_CAP_UNIVERSE_SIZE}
```
- `SMALL_CAP_UNIVERSE_SIZE` — קונפיג, ברירת מחדל 150, דריסה ב-env
  `SMALL_CAP_UNIVERSE_SIZE`.
- מהתשובה לוקחים: `symbol`, `companyName`, `sector`, **`marketCap`** —
  כך יש לנו שווי שוק אמיתי בלי קריאות פר-מניה.
- לסנן סימולים עם `.` או `/` (כמו ב-alpacaService).
- אם הקריאה נכשלת/ריקה → `null`.
- **מימוש בתוך marketDataService או בשירות החדש:** לממש את קריאת ה-screener
  בשירות החדש עם `fetchJson` משלו (עותק מקומי קטן או ייצוא של
  `fetchJson` מ-marketDataService — עדיף לייצא ולעשות שימוש חוזר, כולל
  ה-cache שלו).

### 2.2 שלב 2: נתונים טכניים מ-Alpaca (batch)

`alpacaService.getDailyBars({ symbols, days: 420 })` — ‏420 ימים
קלנדריים ≈ ~290 ימי מסחר, מספיק ל-MA200. (ה-adapter הקיים כבר תומך
ב-`days` פרמטרי, chunks של 200, pagination — אין לשנות אותו.)

לכל סימול עם ≥60 bars, לחשב מקומית (bars ממוינים מהישן לחדש) את אותם
שדות שהמערכת מכירה, באותם שמות בדיוק כמו ב-`marketDataService`:
- `price` (close אחרון), `daily_change`, `gap_pct` (open אחרון מול close
  קודם), `adr_pct` (ממוצע 20 אחרונים של ‎(h−l)/l×100‎)
- `volume` (v אחרון), `average_volume_30d` (ממוצע 30 אחרונים)
- `high_52w`/`low_52w` (max h / min l על כל ה-bars)
- `MA50`, `MA200` (ממוצעי close; אם אין 200 bars — לחשב על מה שיש
  ולסמן ב-`imputedFields`), `ma50_slope` (כמו הקיים: MA50 מול MA50 של
  לפני 5 ימים)
- `volatility` (סטיית תקן של תשואות יומיות, 20 אחרונים — אותה הגדרה
  כמו הקיים)
- `return_3m` (‏close אחרון מול close לפני ~63 ימי מסחר)
- `consolidation_score` — לייצא את `scoreConsolidation` הקיים מ-
  `marketDataService` ולהשתמש בו (לא לשכפל)
- `price_near_daily_high` = close/high של ה-bar האחרון
- `market_cap` — מה-screener (שלב 1); `revenue_growth_pct: 0`,
  `dividend_yield: 0`, שניהם ב-`imputedFields`
- `data_source: 'alpaca+fmp-screener'`

### 2.3 caching

תוצאת ה-universe נשמרת ב-cache בזיכרון (אותו דפוס `MARKET_DATA_CACHE`
הקיים, TTL של 5 דקות), key: `smallcap:{exchange}` — כדי שסריקות חוזרות
לא ימשכו הכול מחדש.

## 3. חלק ב' — לוגיקת הניקוד (strategies.js)

מפתח: `small_cap_breakout`. תווית: `מניות קטנות נפיצות (Small-Cap)`.

### 3.1 פילטר כשירות (מכפיל 0 אם אחד לא מתקיים)

- `market_cap` קיים ו**מתחת ל-2,000,000,000**
- `price >= 2`
- `adr_pct >= 5`

הפילטר הזה הוא שמבטיח שבמצב fallback (universe של ענקיות) האסטרטגיה
תחזיר ציונים 0 — התנהגות כנה, לא תוצאות מזויפות.

### 3.2 ניקוד (משקולות ב-scoringConfig.js, סכום 1)

```js
small_cap_breakout: {
  volumeSurge: 0.3,     // normalize(volumeRatio, 2, 6)
  momentum: 0.3,        // normalize(max(gap_pct, daily_change), 4, 20)
  breakout: 0.25,       // average של normalize(highProximity, 0.85, 1) ו-consolidation_score
  relativeStrength: 0.15 // stock.relativeStrength (כבר מחושב ב-enrichStock)
}
```

הערות:
- `momentum` משתמש ב-`Math.max(gap_pct, daily_change)` — אותו דפוס
  קיים ב-swing_momentum (episodic pivot).
- אסור להוסיף את `adr_pct` גם כגורם ניקוד — הוא כבר משמש בפילטר
  הכשירות (עקרון אי-כפילות סיגנל).

### 3.3 הסבר בעברית

- עומדת בפילטר: לפי הדומיננטי — "פריצת נפח במניה קטנה: נפח פי X
  מהממוצע עם תנועה חדה" / "מומנטום נפיץ: גאפ/תנועה יומית חדה בנפח
  חריג".
- לא עומדת: "אינה עומדת בפרופיל: נדרש שווי שוק קטן מ-2 מיליארד, מחיר
  מעל 2$, וטווח תנודה יומי (ADR) של 5% לפחות".

## 4. חלק ג' — אינטגרציה

### 4.1 scannerService.analyzeMarket

בתחילת `analyzeMarket`, אם `strategy === 'small_cap_breakout'`:
1. לנסות `getSmallCapUniverse({ exchange })`.
2. אם חזר מערך לא-ריק — הוא מחליף את `stocks` (ה-universe הרגיל לא
   נטען בכלל עבור הסריקה הזו; מדדי הייחוס SPY/QQQ/IWM נטענים כרגיל).
   `source` בתשובה: `'alpaca+fmp-screener'`.
3. אם חזר `null` — ממשיכים עם ה-universe הרגיל בדיוק כמו היום, ומוסיפים
   ל-`analysis.dataQuality.issues` הודעה: "האסטרטגיה דורשת מאגר מניות
   קטנות (Alpaca) שאינו זמין כרגע — הסריקה רצה על המאגר הרגיל".

**חשוב — הליגה:** `buildStrategyTopPicks` ממשיך לרוץ על ה-universe של
הסריקה הנוכחית, כמו היום, בלי שינוי. (המשמעות: כשסורקים עם
small_cap_breakout, שאר האסטרטגיות מנוקדות על universe של מניות קטנות
וההפך. זו מגבלה ידועה ומקובלת של השוואת הליגה — לתעד בהערת קוד קצרה,
לא לפתור עכשיו.)

### 4.2 רישום בכל נקודות האינטגרציה (אותו checklist כמו swing_momentum)

- `STRATEGY_KEYS` (analysisService)
- `STRATEGY_WEIGHTS` (scoringConfig — סעיף 3.2)
- `STRATEGY_REGIME_FIT_MATRIX` (marketRegimeService):
  bullish=high, volatile=medium, sideways=low, bearish=low, unknown=medium
  (בשוק צדדי פריצות small-cap נכשלות הרבה — לכן low, שונה מ-swing)
- `STRATEGY_LABELS` (strategies.js) + `STRATEGY_DISPLAY_LABELS`
  (expertSupportService, כולל entry ב-PRIMARY_EXPERTS בסגנון תיאורי:
  "סגנון מניות קטנות נפיצות", ללא שם אדם)
- `EVALUATION_HORIZON_DAYS` (scanHistoryService): **10** ימים
- `estimateUpside` (opportunityScoringService): `minPct=10, maxPct=35`
- `explanationService`: הסבר + `fitHorizon`: "מהלכים קצרים ואלימים
  במניות קטנות (ימים עד שבועות) — סיכון גבוה, מחייב גודל פוזיציה קטן
  ונקודת יציאה מוגדרת מראש"
- **לא** להוסיף ל-`REGIME_RECOMMENDED_STRATEGY` — ההמלצה האוטומטית לא
  תדחוף משתמשים לאסטרטגיה בסיכון גבוה; היא נבחרת רק במפורש.
- `indiOverlayService` — לא להוסיף (נשאר לשתי האסטרטגיות הקיימות).

### 4.3 client (App.jsx)

1. אופציה בבורר: `מניות קטנות נפיצות (Small-Cap)` עם תיאור שמדגיש
   פוטנציאל של עשרות אחוזים **וגם** סיכון מקביל.
2. **באנר אזהרה קבוע** כשהאסטרטגיה הזו נבחרת (מעל התוצאות, בסגנון
   `watchlist-disclaimer` הקיים): "אסטרטגיה בסיכון גבוה: מניות קטנות
   יכולות לנוע בעשרות אחוזים לשני הכיוונים. מומלץ גודל פוזיציה קטן
   ונקודת יציאה מוגדרת מראש."
3. אם ה-fallback הופעל (אין Alpaca), הערת ה-dataQuality מסעיף 4.1 כבר
   תוצג דרך המנגנון הקיים — אין צורך ב-UI נוסף.

### 4.4 תיעוד

- README: האסטרטגיה החמישית בסעיף האסטרטגיות + עדכון סעיף המשפך
  (עכשיו יש שני צרכנים ל-Alpaca: ה-watchlist וה-universe של small-cap).
- docs/TESTING_PLAN.md: עדכון חלוקת התיק — חצי AMZN (מסלול Swing),
  חצי על המניה המובילה של small_cap_breakout (מסלול חדש, אותם כללים:
  אופק 10 ימי מסחר, מדידה מול SPY, בלי מסחר יומי); רשימת המעקב ממשיכה
  תיעוד ידני כרגיל.
- docs/LOGIC_IMPROVEMENTS.md: סעיף 7.6 קצר.

## 5. טסטים (חובה)

`server/test/smallCapStrategy.test.js`:
1. פילטר כשירות: ענקית (50B) → ציון 0; מחיר 1.5$ → 0; ADR 3% → 0.
2. כיוון ניקוד: נפח פי 4 מנצח נפח פי 2 (בשאר שווה); גאפ 15% מנצח 5%.
3. אינטגרציה: `analyzeMarket` עם mock ל-`getSmallCapUniverse` שמחזיר
   מניות קטנות → מחזיר תוצאות עם `source==='alpaca+fmp-screener'`.
4. fallback: בלי מפתחות Alpaca → `analyzeMarket` רץ על ה-universe הרגיל,
   לא זורק, ומחזיר את הודעת ה-issue.

`server/test/smallCapUniverse.test.js`:
5. שלב 1: screener mock מחזיר מועמדים → נשלחים ל-Alpaca ב-batch אחד.
6. חישובי שדות: bars ידועים → `adr_pct`/`MA50`/`high_52w`/`daily_change`
   יוצאים כמצופה (ערכים מדויקים על קלט קטן בעבודת יד).
7. screener נכשל → `null`; Alpaca מחזיר Map ריקה → `null`.
8. סימול עם פחות מ-60 bars מדולג ולא מפיל את השאר.

## 6. קריטריוני קבלה

1. כל הטסטים (70 + חדשים) עוברים; build נקי.
2. בלי מפתחות Alpaca: כל 5 האסטרטגיות רצות בלי שגיאה; small_cap מחזירה
   "אין סטאפים" + הודעת הסבר.
3. עם מפתחות (בדיקה ידנית של המשתמש): סריקה עם האסטרטגיה החמישית
   מחזירה מניות עם שווי שוק מתחת ל-2B בלבד, ADR≥5%, ומקור
   `alpaca+fmp-screener`.
4. באנר האזהרה מוצג רק כשהאסטרטגיה הזו נבחרת.
5. `REGIME_RECOMMENDED_STRATEGY` לא כולל אותה.
6. צריכת FMP: קריאת screener אחת לסריקה (עם cache) — לא קריאות פר-מניה.

## 7. סדר ביצוע (commits)

1. `smallCapUniverseService.js` + ייצוא `fetchJson`/`scoreConsolidation`
   מ-marketDataService + טסטים שלו.
2. לוגיקת הניקוד + רישום בכל נקודות האינטגרציה + טסטים שלה.
3. חיווט `analyzeMarket` + client (בורר + באנר) + טסט אינטגרציה/fallback.
4. תיעוד (README, TESTING_PLAN, LOGIC_IMPROVEMENTS) — commit נפרד.

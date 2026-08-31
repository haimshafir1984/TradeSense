# TradeSense v2 — איפיון מערכת חדשה

תאריך: 2026-08-31
סטטוס: **איפיון בלבד — טרם מומש**
קהל היעד: המפתח שיישם (Sonnet). מסמך זה הוא ההוראה המחייבת; אין להסיק החלטות מהקוד הישן.

---

## 0. רקע — למה בונים מחדש

המערכת הקיימת מייצרת **דירוג** של מניות. היא לא מייצרת **עסקה**. אין בה חוק יציאה, אין time-stop, ואין גודל פוזיציה נגזר. בטווח קצר התוחלת נשלטת כמעט לגמרי ע"י היציאה והגודל — ולכן מערכת שמייעלת רק את הבחירה לא יכולה לעבוד, גם אם הבחירה מצוינת.

שלוש עובדות שמעצבות את כל האיפיון הזה:

1. **הסימטריה.** קבוצת המניות שיכולות לקפוץ 12% ביום היא כמעט אותה קבוצה שיכולה ליפול 12% ביום. כריית האנומליות של הפרויקט עצמו מדדה base rate של ~1% לקפיצה כזו, ותבניות ששרדו holdout העלו את זה ל-5-7% בלבד. **כלומר גם התבנית הטובה ביותר טועה ב-93-95% מהמקרים.** מערכת שמניחה אחרת שבורה מיסודה.
2. **הבחירה חשובה יותר מהתבנית.** במחקר ORB של Zarattini/Barbon/Aziz, אותה תבנית בדיוק הניבה 29% ללא פילטר בחירה ו-1,637% עם פילטר נפח יחסי. הפילטר עשה את העבודה.
3. **אין מדידה.** אין בפרויקט ולו תוצאה אחת מתועדת. לכן אף אמירה על "עובד/לא עובד" אינה נתמכת כרגע בראיות, לשני הכיוונים.

## 0.1 מה המערכת הזו איננה

- **אינה ייעוץ השקעות ואינה המלצת רכישה.** היא מציגה לוגיקות מסחר מתועדות ואת מצב הנתונים מולן.
- **אינה מנבאת קפיצות.** היא מוצאת מצבים שבהם ההסתברות לתנועה גדולה גבוהה מהרגיל, ומצמידה לכל אחד תוכנית יציאה שמגבילה את המחיר של הטעות.
- **אינה מתחברת לברוקר ואינה מבצעת פעולות.** אין נתיב קוד למסחר בפועל, בשום שלב.

---

## 1. עקרונות מחייבים

אלה גוברים על כל שיקול אחר. הפרה של אחד מהם היא באג, גם אם הקוד עובד.

1. **אסור להמציא מספרים.** אם ערך לא נמדד — הוא `null`, לא ערך ברירת מחדל. אסור להחזיר "תשואה צפויה", "ציון הזדמנות" או כל מספר שנראה מדויק ואין מאחוריו מדידה. זו הסיבה המרכזית שהמערכת הישנה מטעה.
2. **כל פלייבוק מצהיר על מצבו.** `status: 'paper' | 'active'`. פלייבוק נשאר `paper` עד **30 עסקאות סגורות ומתועדות לפחות**. ה-UI חייב לסמן `paper` בבירור. אין יוצא מן הכלל.
3. **אין lookahead.** כל פיצ'ר מחושב אך ורק מנתונים שהיו זמינים ברגע ההחלטה. בדיקת תוצאה משתמשת בנרות שאחרי ההחלטה בלבד.
4. **כל מועמד = עסקה שלמה.** אסור להחזיר מועמד ללא `plan` מלא (כניסה, סטופ, יעד, time-stop). מועמד בלי תוכנית יציאה נזרק, לא מוצג.
5. **fail-soft.** כשל ספק מחזיר תוצאה חלקית עם סימון, לא קריסה ולא נתון מומצא.
6. **אין מסחר חי.** אין קוד שמתחבר לברוקר.
7. **התיעוד הוא חלק מהמשימה.** כל פאזה מסתיימת ב-commit נפרד עם עדכון `CLAUDE.md`.

---

## 2. מה נמחק

מוחקים לחלוטין, כולל הטסטים שלהם:

| קובץ | סיבה |
|---|---|
| `services/strategies.js` | מוחלף ב-`playbooks/` |
| `services/scannerService.js` | מוחלף ב-`pipeline/` |
| `services/analysisService.js` | אורקסטרציה ישנה |
| `services/expertSupportService.js` | שמות סוחרים — סמכות מדומה, אפס תוכן חזוי |
| `services/indiOverlayService.js` | בונוסים ידניים `+20`/`+18` שהומצאו |
| `services/opportunityScoringService.js` | `opportunityScore = expectedReturnPct × 3.2` — מספר קסם |
| `services/explanationService.js` | הסברים נבנים בתוך הפלייבוק |
| `services/marketRegimeService.js` | הרעיון נשמר, המימוש נבנה מחדש (§5.6) |
| `services/watchlistService.js`, `watchlistScoring.js`, `watchlistLearningService.js`, `watchlistScheduler.js`, `watchlistOutcome*.js` | הפיצ'ר מוחלף ע"י ה-ledger (§5.7) |
| `services/funnelScanService.js`, `smallCapUniverseService.js` | הרעיון (משפך) נשמר, המימוש נבנה מחדש |
| `services/scanHistory*.js` | מוחלף ב-ledger |
| `routes/analyze.js`, `watchlist.js`, `watchlistOutcomes.js`, `strategyLeague.js`, `scanHistory.js` | חוזה API חדש (§6) |
| `config/scoringConfig.js` | מוחלף ב-`config/playbookConfig.js` |
| `client/src/App.jsx` (לוגיקת הסריקה) | ממשק חדש (§8) |

**לא נמחק אך יוצא מהמסלול:** `services/research/**` (כריית אנומליות + סקר GitHub) ו-`vibeTradingService.js` — כלים ידניים עצמאיים, נשארים כפי שהם. אל תשלב אותם במסלול החדש.

`services/portfolioService.js` / `portfolioStore.js` — נשארים ללא שינוי (פיצ'ר נפרד).

---

## 3. מה נשאר — שכבת ה-API בלבד

**זה כל מה שמותר להסתמך עליו מהקוד הקיים.**

### 3.1 `services/providers/alpacaService.js` — ללא שינוי, בתוספת פונקציה אחת

```
isConfigured() -> boolean
getActiveAssets({ exchange }) -> [{ symbol, name, exchange, ... }] | null
getDailyBars({ symbols, days, feed = 'iex' }) -> Map<symbol, bar[]>   // bar: {t,o,h,l,c,v}, ממוין ישן→חדש
getLatestDailyBars({ symbols }) -> Map<symbol, bar>
getSnapshots({ symbols }) -> Map<symbol, snapshot>                     // כולל dailyBar/prevDailyBar/latestTrade
```

**להוסיף** (§7.1): `getIntradayBars({ symbols, timeframe, start, end, feed })`.

⚠️ **מגבלת feed:** ברירת המחדל `iex` מכסה רק חלק מנפח השוק. לכן כל חישוב נפח יחסי במערכת הוא **יחסי-בתוך-עצמו** (מדרג מניות זו מול זו) ואסור להציג אותו כנפח מוחלט. יש לתעד זאת ב-UI.

### 3.2 `services/providers/nasdaqService.js` — ללא שינוי

```
isAvailable() -> boolean
getScreenerRows({ exchange, marketCapTiers, limit }) -> [{ symbol, companyName, marketCap, price, dailyChangePct }] | null
```

### 3.3 `services/providers/finnhubService.js` — ללא שינוי, בתוספת פונקציה אחת

```
isConfigured() -> boolean
getEarningsSoon(ticker, lookaheadDays) -> boolean | null
getCompanyProfile(ticker) -> { companyName, sector, marketCap, shareOutstanding } | null
getRecentNewsCount(ticker) -> number | null
```

**להוסיף** (§7.2): `getEarningsSurprises(ticker)`.

### 3.4 תשתית universe — ללא שינוי

```
universeStore.js:          readUniverseCache, writeUniverseCache, writeUniverseEntry, getUniverse, getPreviousEntry
universeBuilderService.js: refreshUniverse, getUniverseWithLazyRefresh, dataSourceLabelFor
```

הרענון הלילי + fallback לדיסק הוא תשתית טובה ונשאר.

### 3.5 `services/mathUtils.js` — נשאר, מנוקה

שומרים: `clamp`, `round`, `average`, `median`, `computeRsi`, `computeTrailingReturnPct`.
מוחקים: `scoreConsolidation` (שייך ללוגיקה הישנה).

### 3.6 FMP

**לא בשימוש ב-v1.** מכסה חינמית של 250 קריאות/יום ובעיות מתועדות. אם יידרש בעתיד — לחלץ `providers/fmpService.js` דק, לא לגעת ב-`marketDataService.js` הישן (שנמחק).

---

## 4. ארכיטקטורה — סקירה

```
שכבה 0   שער נזילות        universe → מניות שבכלל ניתן לסחור בהן
שכבה 1   קטליזטור          מה קרה למניה הזו? (דוח/חדשות/גאפ)
שכבה 2   בחירה             דירוג לפי נפח יחסי → Top-N
שכבה 3   פלייבוקים         4 לוגיקות מתועדות, כל אחת מייצרת עסקה שלמה
שכבה 4   מנוע יציאה        סטופ + יעד + time-stop + גודל
שכבה 5   רמת סיכון         איזה פלייבוק מותר, באיזה גודל, בכמה פוזיציות
שכבה 6   שער משטר שוק      מתי לא לסחור בכלל
שכבה 7   ledger            תיעוד כל מועמד + תוצאה, אוטומטית
```

תלות חד-כיוונית: `pipeline → playbooks → exitEngine → providers`. אסור לפלייבוק לקרוא לספק ישירות.

מבנה תיקיות חדש:

```
server/src/
  providers/          (הועבר מ-services/providers, ללא שינוי תוכן)
  pipeline/
    liquidityGate.js
    catalystService.js
    selectionService.js
    regimeGate.js
    runScan.js
  playbooks/
    index.js            רישום + מטא-דאטה
    peadDrift.js
    gapContinuation.js
    shortTermReversal.js
    openingRangeBreakout.js
    features.js         חישוב פיצ'רים as-of, משותף
  risk/
    exitEngine.js
    riskTiers.js
    positionSizing.js
  ledger/
    ledgerStore.js
    outcomeResolver.js
    playbookStats.js
  routes/
    candidates.js
    playbooks.js
    ledger.js
```

---

## 5. איפיון השכבות

### 5.0 שכבה 0 — שער נזילות (`liquidityGate.js`)

מקור הספים: מחקר ORB (Zarattini/Barbon/Aziz 2024).

| תנאי | ערך |
|---|---|
| מחיר | `>= 5` דולר |
| נפח יומי ממוצע (20 יום) | `>= 1,000,000` מניות |
| ATR14 | `>= 0.50` דולר |
| היסטוריית נרות | `>= 200` נרות יומיים |

```js
applyLiquidityGate(stocks) -> { passed: Stock[], rejected: [{ symbol, reason }] }
```

מניה שנפלה חייבת לקבל `reason` מפורש. חובה להחזיר גם את הנדחים — הם נדרשים לדיאגנוסטיקה ב-UI.

### 5.1 שכבה 1 — קטליזטור (`catalystService.js`)

**זו השכבה שקובעת אם יש בכלל אסימטריה בין מעלה למטה.** תנועה גדולה בלי סיבה מזוהה היא רעש סימטרי; תנועה עם קטליזטור היא הדבר היחיד שנותן בסיס לצפות לכיוון.

```js
detectCatalysts(symbols) -> Map<symbol, {
  kind: 'earnings_surprise' | 'earnings_scheduled' | 'news_spike' | 'gap_no_news' | null,
  earningsSurprisePct: number | null,   // Finnhub getEarningsSurprises
  daysSinceEarnings: number | null,
  newsCount48h: number | null,          // Finnhub getRecentNewsCount
  premarketGapPct: number | null,       // Alpaca getSnapshots
  confidence: 'high' | 'medium' | 'low'
}>
```

- `high` — הפתעת רווחים מספרית ידועה
- `medium` — דוח מתוזמן או ספייק חדשותי (≥5 כתבות ב-48ש)
- `low` — גאפ ללא חדשות מזוהות. **חייב להיות מסומן כדגל אזהרה ב-UI**, לא כאיכות.

`null` בכל שדה = לא ידוע. אסור להמיר ל-0.

### 5.2 שכבה 2 — בחירה לפי נפח יחסי (`selectionService.js`)

**השכבה שנושאת את ה-edge לפי המחקר.**

```js
rankByRelativeVolume(stocks, { window = 14, topN = 20 }) -> RankedStock[]
```

- `rvolDaily = volume(היום) / ממוצע volume ב-14 המסחר הקודמים`
- `rvolOpening = נפח 5 הדק' הראשונות / ממוצע נפח 5 הדק' הראשונות ב-14 הימים הקודמים` — **רק כשיש נתונים תוך-יומיים** (פאזה 4); אחרת `null`
- דירוג לפי `rvolOpening` אם קיים, אחרת `rvolDaily`
- מחזיר Top-N בלבד

חובה שהערך המדורג יסומן במפורש כ**יחסי בין מניות** (מגבלת feed `iex`, §3.1).

### 5.3 שכבה 3 — פלייבוקים

חוזה אחיד. כל פלייבוק מייצא:

```js
{
  key: string,
  label: string,               // עברית
  status: 'paper' | 'active',  // תמיד 'paper' בהתחלה
  evidence: {
    strength: 'strong' | 'moderate' | 'weak',
    sources: string[],
    note: string               // כולל את מגבלות הראיות
  },
  horizonDays: number,
  allowedRiskTiers: string[],
  requiresIntraday: boolean,

  evaluate(stock, context) -> {
    eligible: boolean,
    reason: string | null,     // חובה כש-eligible=false
    conviction: number|null,   // 0-1, רק לדירוג פנימי. אסור להציג כהסתברות.
    factors: [{ key, label, value, detail }],
    plan: TradePlan | null
  }
}
```

`conviction` הוא **דירוג יחסי בלבד**. אסור להציגו כאחוז הצלחה, ואסור לגזור ממנו תשואה צפויה.

---

#### P1 — `peadDrift` (דריפט אחרי הפתעת רווחים)

**ראיות: החזקות בסט.** Ball & Brown (1968), Bernard & Thomas (1989); תשואה עודפת מתועדת 2.6%-9.37% לרבעון. מגבלה שחייבת להיכתב: האפקט נחלש עם השנים ורגיש לעלויות מסחר.

| פרמטר | ערך |
|---|---|
| שער | דוח פורסם ב-1-3 ימי מסחר האחרונים |
| טריגר | `earningsSurprisePct >= 5` **וגם** תשואת יום-הדוח `>= +2%` |
| כיוון | לונג בלבד (v1) |
| סטופ | `2.5 × ATR14` |
| יעד | `3R` |
| time-stop | 30 ימי מסחר |
| אופק | 20-60 יום |
| רמות סיכון | שמרני, מאוזן |

גורמי `conviction`: גודל ההפתעה, עוצמת תגובת היום, RVOL ביום הדוח, מרחק מהשיא.

---

#### P2 — `openingRangeBreakout` (פריצת טווח פתיחה)

**ראיות: בינוניות-חזקות, אך עם הסתייגות מהותית.** Zarattini/Barbon/Aziz (2024). ⚠️ המאמר הניח **אפס slippage** ועמלה של $0.0035/מניה; ה-edge מגיע כמעט כולו מפילטר הבחירה (29% ללא פילטר מול 1,637% איתו). זהו הפלייבוק הכי קרוב למטרה "קפיצה יומית" — וגם הכי רגיש לתנאי ביצוע.

| פרמטר | ערך |
|---|---|
| דרישה | נרות 5 דקות (`requiresIntraday: true`) |
| בחירה | Top-20 לפי `rvolOpening` |
| טריגר | פקודת stop מעל שיא נר 5 הדק' הראשון, בכיוון הנר |
| סטופ | `0.10 × ATR14` — **צמוד מאוד** |
| יציאה | סוף יום המסחר |
| time-stop | אותו יום |
| רמות סיכון | אגרסיבי בלבד |

**חובה מאחורי feature flag `ORB_ENABLED` (ברירת מחדל: כבוי)** — הוא דורש נתונים ותזמון שאין למערכת ב-v1.

---

#### P3 — `gapContinuation` (המשך גאפ)

**ראיות: חלשות — החלש בסט.** המקורות הם בלוגים מסחריים ולא מחקר שפיט. חובה לכתוב בשדה `evidence.note`: *"הנתון של ~60% המשכיות מגיע ממקור מסחרי לא שפיט; יש להתייחס אליו כהשערה בלבד."*

| פרמטר | ערך |
|---|---|
| שער | `premarketGapPct >= 3` **וגם** `rvol >= 2` **וגם** קטליזטור `high`/`medium` |
| טריגר | פריצת שיא 15 הדק' הראשונות; ללא נתוני intraday — מחיר הפתיחה |
| סטופ | `1.0 × ATR14`, או מתחת לשפל הפרה-מרקט (הקרוב מביניהם) |
| יעד | `2R` |
| time-stop | 3 ימי מסחר |
| רמות סיכון | מאוזן, אגרסיבי |

**גאפ ללא קטליזטור נדחה.** זו בדיוק הקטגוריה הסימטרית מ-§0.

---

#### P4 — `shortTermReversal` (היפוך קצר-טווח)

**ראיות: בינוניות-חזקות.** Lehmann (1990), Jegadeesh (1990). מתועד היטב; עובד דווקא כשמומנטום נכשל, ולכן מוסיף גיוון אמיתי לסט.

| פרמטר | ערך |
|---|---|
| שער | `price > MA200` — **מנגנון הבטיחות המרכזי** |
| טריגר | `return5d <= -8%` **וגם** `RSI14 < 30` **וגם** `rvol >= 2` |
| סטופ | `1.5 × ATR14` |
| יעד | חזרה ל-MA20, או `2R` — הקרוב |
| time-stop | 10 ימי מסחר |
| רמות סיכון | שמרני, מאוזן |

השער על MA200 אינו ניתן לעקיפה בשום רמת סיכון. בלעדיו זו קניית מניה בדרך לאפס.

---

### 5.4 שכבה 4 — מנוע יציאה (`exitEngine.js`)

**הרכיב שלא היה קיים והוא הסיבה המרכזית לבנייה מחדש.**

```js
buildTradePlan({ entryPrice, atr14, stopMultiple, targetR, timeStopDays, accountRiskUsd }) -> {
  entry:   { price, type },
  stop:    { price, distancePct, distanceR: 1, basis: 'atr14 × 2.5' },
  target:  { price, rMultiple, gainPct },
  timeStopDays,
  sizing:  { shares, riskUsd, notionalUsd } | null,
  valid: boolean,
  invalidReason: string | null
}
```

חוקים:
- `atr14` חסר או לא תקין → `valid: false`. **תוכנית לא תקינה פוסלת את המועמד לגמרי.**
- `shares = floor(accountRiskUsd / (entryPrice - stopPrice))`; ללא `accountRiskUsd` → `sizing: null` (לא 0, לא ניחוש).
- `gainPct` נגזר מתמטית מהמחירים בלבד — **זו לא תחזית תשואה** ואסור לתייג אותה כך ב-UI.

### 5.5 שכבה 5 — רמות סיכון (`riskTiers.js`)

רמת סיכון היא **צירוף של פלייבוקים + גודל + אופק**, לא ציון.

| | שמרני | מאוזן | אגרסיבי |
|---|---|---|---|
| פלייבוקים | P1, P4 | P1, P3, P4 | P2, P3 |
| סיכון לעסקה | 0.5% | 1.0% | 1.0% |
| פוזיציות במקביל | 3 | 5 | 3 |
| תקרת הפסד יומית | — | 3% | **2%** |
| שווי שוק | `> 10B$` | `2B-200B$` | `300M-10B$` |
| אופק | 20-60 יום | 3-30 יום | תוך-יומי - 3 ימים |

תקרת ההפסד היומית ברמה האגרסיבית היא חובה: זו הרמה שבה 93-95% מהמועמדים לא יקפצו.

### 5.6 שכבה 6 — שער משטר שוק (`regimeGate.js`)

פשוט ומדיד, על SPY בלבד:

```js
assessRegime() -> { state: 'risk_on'|'neutral'|'risk_off', spyAboveMa200: boolean, realizedVol20d: number, blockedTiers: string[] }
```

- `spy > MA200` **וגם** תנודתיות 20 יום מתחת לחציון שנתי → `risk_on`
- `spy < MA200` → `risk_off`, **חוסם את הרמה האגרסיבית**
- אחרת `neutral`

השער חוסם רמות, לא מדרג מניות. כשרמה חסומה — להחזיר הודעה מפורשת, לא רשימה ריקה בלי הסבר.

### 5.7 שכבה 7 — Ledger (`ledger/`)

**בלי זה אין למערכת שום דרך לדעת אם היא עובדת. זו לא תוספת — זו דרישת ליבה.**

כל מועמד שהוצג נרשם אוטומטית:

```js
{
  id, createdAt, ticker, playbook, riskTier,
  featuresAtDecision: { ... },      // צילום מצב, as-of בלבד
  plan: TradePlan,
  regimeAtDecision: string,
  outcome: {
    resolvedAt, exitReason: 'target'|'stop'|'time_stop'|'open',
    returnPct: { d1, d3, d5, d10, d20 },
    mfePct, maePct,                  // התנועה הטובה/הגרועה ביותר בתוך האופק
    rMultiple
  } | null
}
```

- `outcomeResolver.js` רץ פעם ביום, ממלא תוצאות מ-`alpacaService.getDailyBars` **בלבד**. אין הזנה ידנית.
- `playbookStats.js` מחשב לכל פלייבוק: `n`, hit-rate, ממוצע R, חציון R, MAE ממוצע, profit factor.
- **כלל הגראדואציה:** `n >= 30` עסקאות סגורות → מותר לשנות `status` ל-`active`. השינוי ידני ומודע, לא אוטומטי.
- אחסון: `server/src/data/ledger.json` (לא ב-git, כמו שאר קבצי ה-data).

---

## 6. חוזה API חדש

```
GET  /api/candidates?exchange=NASDAQ&riskTier=balanced[&playbook=pead_drift][&accountRiskUsd=200]
  -> { generatedAt, regime, riskTier, candidates: [...], diagnostics: {...}, warnings: [...] }

GET  /api/playbooks
  -> [{ key, label, status, evidence, horizonDays, allowedRiskTiers, stats: { n, hitRate, avgR, ... } | null }]

GET  /api/ledger/stats[?playbook=]
GET  /api/ledger/entries?limit=100
POST /api/ledger/resolve            // הרצה ידנית של outcomeResolver
```

`candidate`:
```js
{
  ticker, companyName, price,
  playbook: { key, label, status },
  catalyst: { kind, confidence, detail },
  selection: { rvol, rank },
  conviction, factors: [...],
  plan: TradePlan,
  warnings: string[]        // למשל: "פלייבוק במצב paper - טרם נמדד"
}
```

`diagnostics` חייב להסביר כמה מניות נפלו בכל שלב (`universe → liquidity → catalyst → selection → playbook`). זה מה שהופך "0 תוצאות" למידע במקום לתקלה.

**`/api/analyze` נמחק.**

---

## 7. פונקציות ספק חדשות

### 7.1 `alpacaService.getIntradayBars`

```js
getIntradayBars({ symbols, timeframe = '5Min', start, end, feed = 'iex' }) -> Map<symbol, bar[]>
```

באותה תבנית בדיוק כמו `getDailyBars`: chunking, throttle, מיון ישן→חדש, fail-soft. אותו endpoint `/v2/stocks/bars` עם `timeframe` שונה — **המפתח הקיים כבר תומך בזה.**

### 7.2 `finnhubService.getEarningsSurprises`

```js
getEarningsSurprises(ticker) -> [{ period, actual, estimate, surprisePercent }] | null
```

מ-`/stock/earnings`. מחזיר `null` כשלא זמין — לעולם לא מערך ריק שנראה כמו "אין הפתעות".

---

## 8. לקוח

מסך אחד: **בחירת בורסה + רמת סיכון + (אופציונלי) סיכון בדולרים לעסקה → רשימת מועמדים**.

כרטיס מועמד — היררכיה מחייבת:
1. **מה הקטליזטור** (למעלה, הכי בולט)
2. **התוכנית**: כניסה / סטופ / יעד / time-stop / כמות
3. **הפלייבוק + תג `paper`** אם רלוונטי
4. גורמים ופירוט — מתקפל

אפשר לשמר את דפוסי `ResultCard` / `ScoreBreakdownBars` הקיימים (הם כבר "why-first"), אך להתאים לחוזה החדש.

**אסור להציג ב-UI:** "תשואה צפויה", "ציון הזדמנות", אחוז הצלחה שלא נמדד, או שם סוחר.
**חובה להציג:** תג `paper`, מקור הראיות של הפלייבוק, אזהרת feed `iex` על נפח יחסי, ו-`diagnostics` כשאין תוצאות.

---

## 9. בדיקות

`node:test` + `node:assert/strict` תחת `server/test/`. חובה לכל פאזה.

לכל פלייבוק, לכל הפחות:
1. המקרה החיובי המובהק → `eligible: true` + `plan.valid: true`
2. כל שער נכשל בנפרד → `eligible: false` עם `reason` ספציפי
3. `atr14` חסר → `plan.valid: false` והמועמד נפסל
4. **טסט אנטי-lookahead**: הזנת נרות עתידיים לא משנה את הפלט

למנוע היציאה: חישוב סטופ/יעד/R, `shares` ללא `accountRiskUsd` → `null`, מרחק סטופ אפס → `valid: false`.

ל-ledger: רישום, פתירת תוצאה מנרות, `n<30` → `status` נשאר `paper`.

---

## 10. סדר ביצוע — commit נפרד לכל פאזה

| # | פאזה | תוצר |
|---|---|---|
| 0 | מחיקה | מוחקים §2, הטסטים עוברים, האפליקציה עולה עם מסלול ריק |
| 1 | ספקים | העברה ל-`providers/` + §7.1 + §7.2 + טסטים |
| 2 | **מנוע יציאה + רמות סיכון** | `exitEngine.js`, `riskTiers.js`, `positionSizing.js` — **קודם לכל פלייבוק** |
| 3 | pipeline | שערי נזילות, קטליזטור, בחירה, משטר + `diagnostics` |
| 4 | P4 + P1 | `shortTermReversal`, `peadDrift` — לא דורשים intraday |
| 5 | P3 | `gapContinuation` |
| 6 | ledger | store, resolver, stats, כלל הגראדואציה |
| 7 | API + לקוח | §6 + §8 |
| 8 | P2 | `openingRangeBreakout` מאחורי `ORB_ENABLED=false` |
| 9 | תיעוד | `CLAUDE.md`, `README.md`, `docs/HOW_IT_WORKS.md`, `docs/EXPLAINER.html` |

**פאזה 2 לפני הפלייבוקים** — זו נקודת השבירה מהמערכת הישנה: מנוע היציאה קיים לפני שיש מה לבחור.

---

## 11. קריטריוני קבלה

1. אין בקוד ולו מספר אחד שנראה כתחזית ואין מאחוריו מדידה.
2. כל מועמד מוחזר עם `plan.valid === true`; אין נתיב שמחזיר מועמד ללא תוכנית יציאה.
3. כל ארבעת הפלייבוקים ב-`status: 'paper'`, וה-UI מסמן זאת.
4. `diagnostics` מסביר כל "0 תוצאות".
5. הטסטים עוברים, כולל טסט אנטי-lookahead לכל פלייבוק.
6. אין קוד שמתחבר לברוקר.
7. `ORB_ENABLED` כבוי, וכבוי = התנהגות זהה לחלוטין לכאילו הפלייבוק לא קיים.
8. `.env` לא נחשף ולא נדרשים מפתחות חדשים.

---

## 12. החלטות — הוכרעו 2026-08-31

1. **מסלול הרצה — הוכרע: מחליף את `main` ישירות.**
   העבודה מתבצעת על `main`, פאזה-פאזה לפי §10, commit נפרד לכל פאזה. אין ענף מקביל ואין תאימות לאחור למערכת הישנה. מכיוון שדחיפה ל-`main` גוררת auto-deploy ל-Render, **בסוף כל פאזה האפליקציה חייבת לעלות ולהגיב** — גם אם המסלול עדיין חלקי. פאזה 0 (מחיקה) מסתיימת בשרת שעולה עם מסלול ריק שמחזיר הודעה מפורשת, לא ב-500.

2. **feed — הוכרע: נשארים על `iex` (החינמי) ב-v1.**
   שדרוג ל-SIP עולה $99/חודש ואינו דורש שינוי קוד (הפרמטר `feed` כבר קיים). ההחלטה נדחית עד שה-ledger יראה פלייבוק שמתקרב לגראדואציה.
   **חובה על המימוש:** כל ערך נפח יחסי במערכת מסומן כמבוסס על כיסוי חלקי (~4% מנפח השוק), וה-UI מציג את האזהרה. יש לתעד גם שההטיה אינה אחידה — נתח IEX נמוך יותר בסמול-קאפ, כלומר ההטיה פועלת נגד בדיוק סוג המניות שהמערכת מחפשת.

3. **ORB — הוכרע: נבנה בפאזה 8 מאחורי `ORB_ENABLED=false`, ולא מודלק.**
   הדלקה תישקל רק אחרי ששלושת הפלייבוקים האחרים צברו מדידות. הנימוק אינו טכני: ההחלטה מתקבלת ב-9:30-9:35 ET (16:30 שעון ישראל), הסטופ הוא 0.10×ATR14 — צמוד ברמה שרגישה קריטית ל-slippage — והמאמר המקורי הניח אפס slippage.

4. **תקופת נייר — הוכרע: כן, כ-3 חודשים.**
   ה-ledger פועל אוטומטית: רישום מועמדים + פתירת תוצאות מנרות יומיים, ללא הזנה ידנית. הערכת קצב: המשך גאפ ~3-5 שבועות ל-30 עסקאות; PEAD והיפוך קצר-טווח ~2-3 חודשים.
   **חובה על המימוש:** אין קיצור דרך לכלל ה-30. אסור להוסיף דגל, פרמטר או מסלול שמאפשר ל-`status` לעבור ל-`active` לפני `n >= 30`.

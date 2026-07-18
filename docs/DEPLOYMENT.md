# פריסה ל-Render — הגדרות נדרשות ומה שלמדנו בדרך

מסמך זה מתעד את הגדרות הפריסה בפועל של TradeSense ב-Render, כולל שני
מכשולים אמיתיים שנתקלנו בהם בהקמה - כדי שהפעם הבאה (או מישהו אחר) לא
יצטרך לגלות אותם מחדש.

## מבנה הפריסה

שני שירותי Render נפרדים, מאותו ריפו:
- **Backend** (`TradeSense`) - מריץ את `server/` (Express). כאן, ורק כאן,
  צריך את כל משתני הסביבה ואת ה-Disk.
- **Frontend** (`TradeSense frontend`) - הבנייה הסטטית של `client/`. לא
  כותב שום דבר לדיסק, לא צריך Disk ולא את משתני האחסון.

## Instance Type

**Starter (0.5 CPU / 512MB), לא Free.** שני נימוקים ששניהם קריטיים:

1. **שירות Free "נרדם"** אחרי 15 דקות בלי תעבורה, ומתעורר רק עם בקשה
   נכנסת. ה-scheduler הפנימי (`watchlistScheduler.js`) רץ בתוך התהליך עצמו
   עם טיימר - אם התהליך ישן ב-`WATCHLIST_SCHEDULE_HOUR`, **הריענון הלילי
   פשוט לא קורה**, גם אם השעה מוגדרת נכון.
2. **Persistent Disk לא זמין על Free** (למיטב הידיעה בזמן הקמת המערכת -
   כדאי לוודא מול דף המחירים העדכני של Render אם זה משתנה).

## Persistent Disk - חובה, לא אופציונלי

בלי Disk, כל קובצי הנתונים (`portfolio.json`, `scanHistory.json`,
`watchlistCache.json`, `watchlistOutcomes.json`, וגם `universeCache.json`
- ה-universe הלילי, ראו docs/SPEC_UNIVERSE_RESILIENCE.md) נכתבים לדיסק
**הזמני** של הקונטיינר - שנמחק בכל deploy חדש (וזה כולל כל push ל-`main`,
כי Render עושה auto-deploy). זו הסיבה שבניסיון הראשון "התיק שלי" לא שמר
כלום.

**חשוב במיוחד עבור `UNIVERSE_STORE_FILE_PATH`:** בלי לוודא שהוא מצביע
על `/var/data/...`, כל deploy מוחק את ה-universe הלילי, וכל סריקה עד
לרענון הלילי הבא (או הרענון העצל בבקשה הראשונה) נופלת בחזרה למסלול
FMP/דמו הישן - בדיוק התסמין שדחף לכתיבת docs/SPEC_UNIVERSE_RESILIENCE.md
מלכתחילה.

### איך זה מוגדר (ב-Backend בלבד)

1. **Settings → (לגלול בתוך העמוד, לא בתפריט הצד) → Disk → Add Disk.**
   שים לב: "Disk" לא מופיע כפריט נפרד בתפריט הימני העליון (Settings) -
   הוא מופיע כקטע בתוך עמוד ה-General, מתחת ל-Instance Type. יש לו כן
   כניסה נפרדת בתפריט הצד השמאלי התחתון (ליד Shell, Scaling וכו').
2. **Mount Path:** בדיוק `/var/data` (case-sensitive, חייב להתאים אות
   באות למשתני הסביבה למטה).
3. **Size:** 1GB - הקבצים האלה קטנים בהרבה מזה.

### משתני הסביבה שמצביעים לדיסק (Backend בלבד)

```env
PORTFOLIO_STORE_FILE_PATH=/var/data/portfolio.json
SCAN_HISTORY_FILE_PATH=/var/data/scanHistory.json
WATCHLIST_STORE_FILE_PATH=/var/data/watchlistCache.json
WATCHLIST_OUTCOME_STORE_FILE_PATH=/var/data/watchlistOutcomes.json
UNIVERSE_STORE_FILE_PATH=/var/data/universeCache.json
REGIME_HISTORY_FILE_PATH=/var/data/regimeHistory.json
```

בלי `Mount Path` תואם בפועל, הכתיבה תיכשל (`ENOENT`, כי `/var/data` לא
קיים כתיקייה) - הוספת משתני הסביבה לבד **לא מספיקה**, צריך גם את ה-Disk.

### איך לוודא שזה עובד (Web Shell)

Render מספק Shell מובנה (בתפריט הצד של השירות):

```bash
ls -la /var/data          # אמור להראות תיקייה קיימת (ריקה בהתחלה)
# אחרי שימוש באפליקציה (הוספת אחזקה/סריקה):
ls -la /var/data          # אמורים להופיע קבצי .json
cat /var/data/portfolio.json   # לבדוק שהנתונים בפנים תקינים
```

## שאר משתני הסביבה (Backend)

ראו את `#### ...` בקטע "משתני סביבה" ב-[README.md](../README.md#משתני-סביבה)
לרשימה המלאה והמעודכנת (`DATA_MODE`, `FMP_API_KEY`, `FINNHUB_API_KEY`,
`ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`, `FMP_UNIVERSE_SIZE`,
`WATCHLIST_SCHEDULE_HOUR`/`WATCHLIST_SCHEDULE_EXCHANGES`, `FUNNEL_*`,
`UNIVERSE_MIN_DOLLAR_VOLUME`/`UNIVERSE_ENRICH_LIMIT`/`NASDAQ_REQUEST_TIMEOUT_MS`,
`SHADOW_SCAN_ENABLED`/`SHADOW_SCAN_EXCHANGES`).
נקודה חשובה אחת שכדאי לחזור
עליה כאן: **`WATCHLIST_SCHEDULE_HOUR` הוא שעון UTC על Render**, לא שעון
ישראל - יש לכוון בהתאם (למשל `19` בקיץ / `20` בחורף כדי לקבל ~22:00 שעון
ישראל בפועל). ה-universe הלילי (`UNIVERSE_STORE_FILE_PATH`) מתרענן באותו
מנגנון תזמון, אז אותה הערה חלה עליו.

**`FINNHUB_API_KEY` כמעט חובה על Render, לא רק "מומלץ"**: הסקרינר של
Nasdaq חסום מ-Render (Akamai מסנן datacenter IPs - ראו
docs/SPEC_UNIVERSE_RESILIENCE.md), אז ברענון הלילי של ה-universe,
Alpaca+Finnhub הוא בפועל המסלול הראשי שעובד (לא Nasdaq). בלי
`FINNHUB_API_KEY`, הרענון הלילי נופל ישר ל-FMP (מכסה יומית מוגבלת),
בדיוק הבעיה המקורית. `FINNHUB_API_KEY` משמש גם, בנפרד, לבדיקות דוחות
רבעוניים קרובים והעשרת שווי שוק/סקטור בזמן סריקה (ראו
docs/SPEC_PROVIDER_REBALANCE.md). ראו את `docs/SPEC_PROVIDER_REBALANCE.md`
סעיף 10 להוראות קבלת מפתח (חינמי, finnhub.io).

## מלכודת נפוצה: הקלדת סימול (ticker) בעברית

אם המקלדת נשארת על עברית בזמן מילוי טופס "הוסף אחזקה", השדה `ticker`
(שאמור להיות `AMZN`) יכול להיכתב בטעות כתווים עבריים (למשל "אמא"). המערכת
לא בודקת/דוחה את זה - היא פשוט לא תמצא נתונים אמיתיים לסימול כזה ותיפול
ל-fallback של נתוני דמו. **תמיד לוודא שהמקלדת על אנגלית לפני הקלדת סימול
מניה**, ולבדוק ב-`cat /var/data/portfolio.json` שה-`ticker` שנשמר הוא
אכן אותיות לועזיות.

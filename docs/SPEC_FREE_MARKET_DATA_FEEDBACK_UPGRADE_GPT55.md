# TradeSense — שדרוג דיוק המעקב ומשוב ההמלצות ממקורות חינמיים

תאריך בדיקה: 23.09.2026. מסמך הוראות ל־GPT‑5.5. מצב: תכנון בלבד; טרם שונה קוד. יש לקרוא יחד עם `docs/SPEC_RECOMMENDATION_FEEDBACK_ENGINE.md` ו־`docs/SPEC_RECOMMENDATION_REVIEW_AND_FAST_MOMENTUM.md`. בכל סתירה על זמינות הנתונים, תוצאות הבדיקה המתועדות כאן מעדכנות את ההנחה הכללית שבמפרט הקודם; אין לעקוף מגבלות רישוי או בטיחות.

## 1. החלטת מוצר

המשוב יתבסס על **כל המלצה שפורסמה** והמעקב אחריה, ללא תלות בקנייה, סגירת עסקה אישית או סימולציה. קודם משפרים את *אמינות המדידה*; רק אחר כך מאפשרים למידע להשפיע על דירוג מועמדות. נתון היסטורי שהגיע כעבור 15 דקות או ביום הבא מתאים לבדיקת ההמלצה, אך אסור להשתמש בו כאילו היה זמין בזמן פרסום ההמלצה.

הנחת היקף מפורשת של בעל המערכת: האתר והנתונים משמשים אותו בלבד ואינם מוצגים לאחרים. אין לרכוש API או לשנות ספק כברירת מחדל. Alpaca Basic הקיים נותן כאן SIP היסטורי ו־quotes היסטוריים, ו־Finnhub הקיים מחזיר כתבות עם זמני פרסום. SEC EDGAR חינמי לצורך שיוך דיווחים. החסר העיקרי הוא זכאות SIP *בזמן אמת*, יכולת להוכיח fill אמיתי וכיסוי חדשות מלא.

## 2. מה אומת ומה לא — הפרדה מחייבת

| מקור/יכולת | מחיר לפי מקור רשמי | בדיקה חיה עם המפתחות המקומיים | משמעות למימוש |
| --- | --- | --- | --- |
| Alpaca IEX בזמן אמת | Basic ללא עלות; IEX בלבד | המתאם הקיים פעיל; probe לנרות 5 דקות החזיר AAPL=424, MSFT=395 בשבוע שנבדק | משאירים נתיב החלטה חי קיים ו־feed מפורש |
| Alpaca SIP היסטורי, סוף בקשה ישן מ־15 דקות | נכלל ב־Basic לפי FAQ של Alpaca | `getBarsDetailed` ל־5Min החזיר AAPL=952, MSFT=942, `complete=true` ובלי שגיאות באותו חלון | בסיס לבדיקת תוצאה בדיעבד; לא אות חי |
| Alpaca SIP נרות דקה | אותו תנאי היסטורי | קריאה ל־AAPL בתאריך 22.09.2026, 14:30–14:35 UTC, החזירה HTTP 200 ו־6 נרות | משפרת רזולוציית סדר אירועים לאחר הבשלה |
| Alpaca SIP historical quotes | אותו תנאי היסטורי | קריאה ל־AAPL באותו חלון החזירה HTTP 200, 100 quotes ו־`next_page_token` | מאפשרת אומדן spread/ask, בכפוף לדגימה ול־pagination |
| Alpaca SIP של הדקות האחרונות | Algo Trader Plus בתשלום לחשבון Trading API; תמחור רשמי שנצפה: $99 לחודש | בקשת quote מהדקות האחרונות החזירה HTTP 403: `subscription does not permit querying recent SIP data` | אין להתייחס ל־SIP כ־live; אין לשלם בלי החלטה נפרדת |
| Alpaca corporate actions | endpoint נגיש עם אותם מפתחות; מחיר נפרד לא הוצג בתיעוד שנבדק | HTTP 200; נצפו 3 `cash_dividends` עבור AAPL בחלון 01.01–23.09.2026 | להשתמש לזיהוי פיצולים/שינויי סימול/דיבידנדים, עם בדיקות כיסוי |
| Finnhub company news | נגיש עם המפתח הקיים; סוג החבילה ומגבלות ההיסטוריה לא אומתו | HTTP 200; 166 ידיעות ל־AAPL בחלון 21–23.09.2026; 26 ידיעות בחלון 18–19.08.2026. ברשומה קיימים `id`, `datetime`, `headline`, `source`, `url` | אפשר להשתמש במטא־נתונים ובזמני הפרסום בממשק האישי; לא להניח כיסוי מלא |
| SEC EDGAR submissions ו־XBRL | גישה חינמית ללא מפתח; מגבלת גישה הוגנת | נבדקו התיעוד והכללים הרשמיים; לא בוצעה קריאה חיה משרת TradeSense | מקור משלים לדיווחי חברה מתוארכים, לא הסבר סיבתי אוטומטי |

הקריאות החיות נערכו ב־23.09.2026 עם מפתחות בסביבת העבודה, בבקשות קריאה קטנות בלבד. לא הודפסו מפתחות. בדיקת רשת ראשונה בסנדבוקס החזירה `fetch failed`; ריצה עם גישה לרשת הצליחה. ספירת נרות/ידיעות היא דוגמת כיסוי בתאריך זה בלבד, לא SLA ולא fixture קבוע. היא אינה הוכחת חינמיות המסלול הספציפי של Finnhub.

מקורות רשמיים: [Alpaca — תוכניות ותמחור](https://docs.alpaca.markets/us/docs/about-market-data-api), [Alpaca — SIP בהיסטוריה לעומת בזמן אמת](https://docs.alpaca.markets/us/docs/market-data-faq), [Alpaca — quotes ופגינציה](https://docs.alpaca.markets/us/reference/stockquotes-1), [Alpaca — corporate actions](https://docs.alpaca.markets/us/reference/corporateactions-1), [SEC — EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [SEC — גישה הוגנת](https://www.sec.gov/about/webmaster-frequently-asked-questions).

### היקף השימוש האישי

[תנאי Alpaca](https://files.alpaca.markets/disclosures/library/TermsAndConditions.pdf) מתייחסים לשימוש אישי ולא מסחרי, בהתאם להיקף שתיאר בעל המערכת. לכן **אין במפרט שער של אישור כתוב להפעלת המסך האישי**. אפשר לממש ולהציג לו מדדים, מחירים והסברים בממשק האישי על סמך הגישה הקיימת. שומרים את המפתחות בשרת, נמנעים מהעתקת גוף כתבות שלא נדרש, ומגבילים גישה למסך ול־API לחשבון שלו. [עמוד התמיכה של Alpaca על הפצה מחדש](https://alpaca.markets/support/redistribute-alpaca-api) רלוונטי רק אם היקף השימוש ישתנה ונתונים יוצגו לאחרים; במקרה כזה בודקים מחדש את התנאים לפני פתיחת גישה. מסמך זה אינו קובע שאין שום תנאי שימוש נוסף לחשבונות הספציפיים.

## 3. מצב הקוד והחוסרים המדויקים

* `server/src/providers/alpacaService.js` הוא המתאם היחיד ל־Alpaca, כולל `getIntradayBars` ו־`getBarsDetailed`, throttling ו־pagination לנרות. הוא אינו חושף כיום historical quotes או corporate actions לשכבת ההמלצות. להרחיב אותו, בלי לבצע `fetch` ישיר לקבצי autopilot.
* `server/src/providers/finnhubService.js` כבר קורא `company-news` אך מחזיר **count בלבד**. להוסיף פונקציה שמחזירה מטא־נתונים נקיים של ידיעות עם `datetime`; לשמור את הפונקציה הישנה לתאימות. בקוד הפעיל `engine.js` שומר count קצר־חיים בלבד עבור `gap_pullback`.
* `server/src/autopilot/recommendations.js` יוצר רק jobs עם horizon=`plan`, ומעריך לפי receipt. `recommendationEvaluator.js` משתמש בפתיחת נר 5 דקות ומסמן no-fill/ambiguous/unresolved. אין להחליף את ה־outcome הישן בשקט בעקבות feed מדויק יותר: evaluatorVersion/dataRevision חדשים.
* `server/src/autopilot/store.js` מכיל ארכיון SQLite. `selection.js` ו־`engine.js` אינם משתמשים בתוצאות לציון מועמדות. `scanAttempt` נמחק אחרי זמן קצר ואינו dataset ללמידת missed opportunities.
* `summaryForUser` כרגע מצרף `MAX(checked_at)` לעמודות לא מקובצות; יש לבחור שורת הערכה אחרונה בצורה דטרמיניסטית לפי horizon, evaluatorVersion ו־dataRevision. שורה ישנה/חסרה אינה אפס תוצאה.

## 4. מימוש נתוני שוק לפי סדר

### 4.1 Probe אוטומטי וזמינות

להרחיב את `recommendations:probe-data` או להוסיף CLI סמוך שיבדוק IEX 5Min, SIP 5Min, SIP 1Min, SIP quotes ו־corporate actions על חלון היסטורי קטן; Finnhub news על שני חלונות; SEC probe עם `User-Agent` מזוהה. להחזיר JSON עם `checkedAt`, endpoint, status/`errorKind`, טווח, feed, count, pagination/coverage, זמן תגובה, `configured`, בלי מפתחות/כותרות/URL עם token ובלי payload מלא. 401/403=`not_entitled_or_auth`, 429=`rate_limited`, 5xx/timeout=`temporary`, 200 בלי מידע=`empty_coverage`; לא `blocked-data` אוטומטי. Probe חייב לעבוד גם בלי מפתחות ולציין במפורש מה לא נבדק.

ב־Alpaca SIP היסטורי לבחור `end <= now - 20min` כמרווח שמרני מעל חסימת 15 הדקות, ואת שעות המסחר לפי `America/New_York` ולוח המסחר הקיים. זמן `fetchedAt` טרי אינו עושה את הנר ל־live. להפריד feed key של IEX מזה של SIP בכל cache/outcome.

### 4.2 Quotes מדודים ובעלי תקציב

להוסיף למתאם Alpaca `getHistoricalQuotesDetailed({symbols,start,end,feed='sip',limit,pageBudget,priority})` דרך מנגנון throttling/timeout/retry הקיים. דרישות: `next_page_token` עד גמר או budget; `partial=true` אם נעצר לפני תום הדפים; timestamps עולים, bid/ask חיוביים ו־`bid<=ask`; דה־דופליקציה; מונה quotes, עמודים, coverage והיעדר תצפיות. API מחזיר תשובה ממוינת קודם לפי סימול ולא בהכרח חלוקה הוגנת בין סימולים; בצעו חלונות/סימולים קטנים. ברירת מחדל: לצרוך quotes רק סביב publication, חלון הכניסה וסביב אירועי stop/target אמביוולנטיים, לא לכל היום ולכל מניה.

Quotes נותנים spread ותצפית על ask/bid, **לא הוכחה ל־fill**. אין לקרוא ל־ask שהיה בתוך טווח הכניסה `filled` בלי מודל קפוא; הוסף `quote_observed_entry_opportunity` מול `plan_model_fill` ו־`actual_trade` (האחרון אינו מקור למידה). לשמור `quoteAt`, `ageMs`, `spreadBps`, תרחיש עלות, מקור וגרסה. quote שחסר, רחוק בזמן או crossed אינו אפס spread. לתת sample windows מוגדרים מראש, למשל quote האחרון עד 30 שניות לפני פתיחת נר זכאי או הראשון עד 30 שניות אחריה, ולסמן איזה מהם שימש. לא למזג quote מאוחר יותר עם החלטה מוקדמת כאילו היה ידוע בזמן אמת.

### 4.3 נרות דקה, SIP ופעולות חברה

להעריך מחדש תוצאה בגרסה חדשה עם SIP 1Min לאחר הבשלה. לשמר גם outcome המקורי על IEX 5Min להשוואה; לגלות שינויי `no_observed_fill`, `target`, `stop` ו־`unresolved` ב־audit. נר דקה עדיין לא פותר סדר בתוך אותה דקה, ואינו מבטיח מחיר ביצוע. מגבלת סוף בקשה: עיבוד outcome אחרי תום יום/אופק בתוספת מרווח פרסום. אם IEX לא כיסה אירוע ו־SIP כן, התוצאה החדשה משפרת את **הכיסוי בדיעבד**, לא את איכות האות שנצפה חי.

להוסיף `getCorporateActionsDetailed` במתאם Alpaca עם pagination ו־shape של קבוצות פעולה (`cash_dividends` וכדומה). להתייחס ל־`data_quality`, `process_date`, `ex_date`, שינוי סימול, split ratio ו־timestamp זמינות כשהספק מספק אותם. אם אירוע split/rename חוצה תוכנית ומחירים ואין normalization ודאי, לסמן `corporate_action_pending`; לא לחשב רווח קיצוני שגוי. התאמת נרות `split` במתאם הקיים אינה מבטיחה שהתוכנית המקורית הותאמה על אותו בסיס. לא להניח שאין אירוע כאשר הקריאה נכשלה.

### 4.4 Finnhub ו־SEC להסבר אירועים

להוסיף `getCompanyNewsMetadata({symbol,from,to})` ל־Finnhub, בתיאום עם throttle קיים. לשמור `id`, `datetime`, `source`, `headline` קצר, `url`, `related`, `fetchedAt`, `availableAt` אם ניתן לאמת, ו־hash; לא להעתיק גוף ידיעה או תמונה שלא נדרש. למנוע שימוש בידיעה כ־decision feature אם `datetime > decisionAt` או זמן הזמינות אינו ידוע. גם `datetime <= decisionAt` אינו מוכיח שהייתה זמינה דרך ה־API בזמן ההחלטה; historical replay זקוק ל־`firstSeenAt` שנמדד בפועל או מסמן uncertainty. הסבר בדיעבד נשמר תחת `post_hoc_explanation` בנפרד.

להוסיף מתאם SEC קטן ל־`data.sec.gov/submissions/CIK##########.json` ולמיפוי ticker↔CIK ממקור SEC. User-Agent מזוהה, cache, rate limit שמרני מתחת לתקרה הרשמית 10 בקשות/שנייה, timeout ו־retry; אין polling על כל מניה בכל scan. לשמור `form`, `accessionNumber`, `filingDate`, `acceptanceDateTime` אם קיים, `primaryDocument`, `url`, `firstSeenAt`. דוח 8-K או 10-Q שפורסם סמוך לתנועה יסווג `possible_context`, לעולם לא `cause`. `companyfacts` אופציונלי לשלב מאוחר יותר; אינו חיוני להסבר הראשוני. אם אין CIK חד־משמעי — `unknown_identity`.

### 4.5 אחסון, הרשאות ומדדים

להוסיף migrations ממוספרות ל־`market_evidence_metadata`, `corporate_action_checks`, `catalyst_events`, `evaluation_revisions` לפי הצורך; idempotency על `(provider,feed,symbol,window,revision)` ובידוד receipts לפי user. לשמור ראיות מחיר מצומצמות הדרושות לשחזור לפי חלון/נייר/feed/revision, עם checksum, מכסת אחסון וגיבוי; לא לשכפל יום quotes מלא לכל המלצה. אם לא נשמרו די ראיות לשחזור מדויק, לציין `reproducibility=limited`. archive אינו כפוף ל־eviction של history. שגיאת ספק אינה פוגעת ב־scan/monitor חי.

במסך האישי להפריד: `תוצאת התוכנית` (מודל), `תנועת המניה`, `הסבר אפשרי` עם מקור/זמן/אי־ודאות. להציג את המידע לבעל החשבון לאחר בדיקות הקבלה. לא לחשוף מפתחות, ולא לאפשר גישה של חשבונות אחרים אם קיימים במערכת.

## 5. החיבור ללמידה המתמשכת

לאחר שהמדידה החדשה יציבה, בונים dataset point-in-time מכל ה־setups הייחודיים. תוצאה מ־SIP היסטורי יכולה להיות label איכותי יותר, אבל פיצ'רים לזמן החלטה באים רק מ־IEX/נתונים שהיו זמינים אז. תוצאות `unresolved`, `ambiguous`, `needs_data`, `corporate_action_pending` אינן 0 ואינן נעלמות מהמכנה. `no-fill` משפיע על יכולת ביצוע בנפרד מתשואה של מקרים עם fill מודלי.

להשלים `d0/d1/d3/d5`, לשמור גרסאות evaluator/dataRevision, לתקן summary, ולבנות מדגם shadow קטן של מועמדות שלא פורסמו כדי למדוד selection bias. אחר כך השוואת baseline/challenger כרונולוגית, הפעלה ב־shadow, prospective paper, ושער הפעלה לדירוג מצומצם בלבד כמתואר ב־`SPEC_RECOMMENDATION_FEEDBACK_ENGINE.md`. אין לאמן על עסקאות המשתמש. אין לפתוח holdout נעול ממחקר קודם. תוצאות unit tests אינן הוכחת יתרון פיננסי או מוכנות production.

## 6. סדר עבודה מחייב ל־GPT‑5.5

1. קרא את המסמך הזה, שני המפרטים המקושרים, `docs/RECOMMENDATION_REVIEW_VALIDATION.md`, וקוד המתאמים/הארכיון/הבחירה. רשום baseline של מצב הקוד וה־git, ושמור על שינויים לא קשורים שכבר קיימים.
2. ממש probe חוזר ובדוק בפועל את החשבון בסביבת הריצה הזמינה. שמור תוצאות מסוננות מסודות במסמך validation. אם אין גישה ל־API, ממש עם fixtures וכתוב בדיוק מה לא אומת; אל תטען שחסר נתון רק כי sandbox חסם רשת.
3. הרחב Alpaca/Finnhub adapters בלבד ל־quotes, corporate actions ומטא־נתונים של חדשות; הוסף SEC adapter. נהל את קריאות הרקע תחת תקציב קצב/זיכרון נפרד ואחרי קדימות monitor/scan.
4. הוסף migrations/metadata, evaluator חדש ל־SIP 1Min ול־quotes, אופקי `d0/d1/d3/d5` ואיכות כיסוי. שמור outcomes קיימים וגרסאות קודמות. תקן summary ושורות evaluation אחרונות.
5. בנה דוח איכות והסברים מבוססי מקורות עם הבחנת `decision_evidence`/`post_hoc_explanation`, והצג אותם בממשק האישי לאחר בדיקות הקבלה.
6. הוסף dataset של כל ההמלצות ו־shadow candidates, ואז challenger לדירוג כמתואר במפרט המשוב. ברירת מחדל: shadow בלבד; אל תפעיל שינוי אסטרטגיה/סיכון באופן אוטומטי.
7. בצע בדיקות יחידה/אינטגרציה, build, stress בתקציב Render, בדיקת API ודפדפן מקומית, ו־probe חי חוזר. תעד מכנים, כיסוי, זיכרון, קצב קריאות ושגיאות; סיים בדוח `מה מומש / מה נבדק / מה נותר לפריסה / מה חסום`.

אין לבצע commit, push או deploy במסגרת הוראת המימוש הזו בלי בקשה מפורשת נוספת. אין לשלב מפתח API בקוד, בלוג או בדוח.

## 7. בדיקות קבלה שלא ניתן לדלג עליהן

* HTTP 200 עם רשימה ריקה נבדל מ־403 subscription ומ־network error; probe עובד ללא מפתחות. אין הדפסת token של Finnhub ב־URL של שגיאה.
* SIP history עם `end` ישן מ־20 דקות מצליח, ו־SIP recent 403 אינו גורם לפעולה מסוכנת/שימוש בנתון מושהה כחי. IEX/SIP נשמרים ב־keys שונים.
* quotes: יותר מדף אחד, token שלא מתקדם, גבול pageBudget, תוצאה ממוינת לפי symbol, crossed quote, spread חסר, timestamp אחרי הזמן המבוקש, סימול ששינה שם. `partial` נשאר גלוי.
* נרות: חור פנימי, יום קצר, halt, split, סף stop ויעד באותה דקה, gap דרך stop, תוצאה שונה בין IEX ל־SIP; אף מקרה לא מוחק את תוצאת הגרסה הישנה.
* חדשות: כתבה לפני פרסום, כתבה אחריו, `datetime` חסר, תוצאה ריקה, 429, CIK לא מזוהה ודיווח SEC מאוחר; לא מתוייג `cause` ואין look-ahead לפיצ'רי החלטה.
* מערכת: אלף receipts לאותו setup נספרים כתצפית מערכתית אחת; API משתמש אינו רואה משתמש אחר; worker ממשיך לאחר restart; כשל ספק לא עוצר ניטור פוזיציות; עיבוד batch לא טוען quotes של כל הסשן לזיכרון.
* עומס: למדוד peak RSS, קריאות לדקה, זמן jobs, גודל DB וגודל תורים. בדיקת דפדפן/API מוכיחה שהמסך האישי מציג מקור וזמן outcome ומגבלות נתונים, ושמשתמש לא מורשה אינו יכול לקרוא אותו.

## 8. גבולות ההנחה שיש לשמר

* היישום והנתונים נשארים לשימושו האישי של בעל החשבון בלבד. אם תיפתח בעתיד גישה לאחרים או שימוש מסחרי, לבדוק מחדש תנאי Alpaca/Finnhub לפני השינוי.
* Finnhub: לבדוק בפועל נפח שימוש, משך היסטוריית news ומגבלות חבילת המפתח הקיים. HTTP 200 במדגם קטן אינו מבטיח כיסוי/קצב קבועים.
* סביבת פריסה: לוודא credentials, outbound network, storage עמיד, backup ו־job scheduling בסביבת היעד. הבדיקה המקומית אינה בדיקת פרודקשן.

אפשר לממש את שכבת המדידה, ה־shadow והממשק האישי בגישה הקיימת, בכפוף לבדיקות הקבלה ולפריסה תקינה. אין לטעון למוכנות production או ליתרון פיננסי על סמך בדיקות יחידה בלבד.

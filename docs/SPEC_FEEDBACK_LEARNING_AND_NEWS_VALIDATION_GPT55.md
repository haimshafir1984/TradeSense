# TradeSense — תיקון, שיפור ובדיקת מנוע הלמידה והחדשות

תאריך: 24.09.2026. מסמך ביצוע ל־GPT-5.5. נקודת מוצא: commit `8642748` ב־`main`. זהו מפרט לעבודה עתידית; עצם כתיבתו אינה מאשרת שהמנגנון תוקן או שחל שיפור בביצועי ההמלצות.

## 1. יעד וכללי יסוד

המנוע לומד מתוצאות **כל ההמלצות שפורסמו**, ללא קשר לקנייה של המשתמש. הוא משנה דירוג של מועמדות עתידיות בתוך אסטרטגיה, ליין, זכאות ומכסות קיימים. החדשות ודיווחי SEC הם ראיות זמינות בזמן החלטה רק אם זמן הזמינות נצפה ונשמר אז; תוצאות איסוף מאוחר משמשות להסבר בדיעבד בלבד. אל תסיק סיבתיות מתזמון כתבה ותנועת מחיר.

שבעה סשני מסחר הם **המועד המוקדם ביותר לבחינת מועמדות להפעלה**, לא הבטחה לשינוי המלצות ביום השביעי. אם אין ראיות קדימה, כיסוי, קבוצת אימות והשוואה מספקים — המשך `shadow`. אין להציג `active_limited` או “מדויק יותר” על בסיס בדיקות סינתטיות או עצם צבירת רשומות. הקפא תנאי gate וגרסתם לפני קריאת תוצאות תקופת הניסוי.

קרא תחילה את `docs/SPEC_FEEDBACK_MEASUREMENT_AND_LEARNING_IMPLEMENTATION_GPT55.md`, `docs/SPEC_FREE_MARKET_DATA_FEEDBACK_UPGRADE_GPT55.md`, `server/src/autopilot/{feedback,selection,engine,recommendations,recommendationEvaluator,market,store}.js`, `server/src/providers/{finnhubService,secService}.js` והבדיקות הקיימות. שמור שינויים לא קשורים ב־worktree. במקרה של סתירה, דרישות מניעת look-ahead, מדידה, validation ו־rollback במסמך המדידות גוברות; המסמך הזה מגדיר את תיקון commit `8642748` ואת בדיקות הקבלה שלו.

## 2. פערים מאומתים לתיקון

1. `tradingSessionsSince(policy.created_at, dataset.as_of)` סופר זמן שחלף, בעוד `buildDataset` מכניס גם המלצות שקדמו ליצירת ה־shadow. 20 תוצאות היסטוריות יכולות לעבור gate אחרי שבוע בלי אף תצפית קדימה.
2. `evaluateGates` מפעיל challenger כשהכמות והכיסוי מספיקים; אין בו אימות כרונולוגי או הוכחה שהדירוג טוב מ־baseline על אותו pool נמדד.
3. `activatePolicy` אינו מוציא מדיניות קודמת מ־`active_limited`. `reviewTick` יכול לאמן גרסאות נוספות; `activePolicy` בוחר אז לפי `updated_at`.
4. באימון `rvol` בא מ־`recommendations.features_json.rvol`; בדירוג `candidateFeatureSnapshot` מקבל גם `row.score` כתחליף. ב־`selection.js`, `score` מייצג גם gap, שינוי מחיר, RSI ומדדים אחרים. `Number(null)` מסווג חסר כאפס.
5. `rollbackPolicy` קיים אך אינו מחובר לניטור איכות אוטומטי. אין בדיקת restart שמוכיחה ששחזור מצב שומר גרסה פעילה אחת.
6. `feedback-learned-*` מכוונן על אותם labels שמשמשים שער קידום. בדיקת היחידה הנוכחית מוכיחה שינוי score בסינתטי, אך לא יתרון עתידי או שלמות זרימת הנתונים.

## 3. סדר העבודה המחייב

### שלב א — סגרי הפעלה ואחידות נתונים

* עד לתיקון gates, מדיניות חדשה נשארת ב־`shadow`; אין קידום אוטומטי על נתונים שהשער הנוכחי מחשב. אל תמחק מדיניות או המלצות קיימות. שמור audit להחלטה.
* צור `FeatureSnapshotV2` קנוני אחד, המופק בעת החלטה ונשמר בארכיון וב־selection pool. שדות: `strategy`, `strategyVersion`, `lane`, `decisionAt`, `featureAvailableAt`, `rvol`, `gapPct`, `atrPct`, `adv20`, `decisionHourNy`, `priceFreshnessMs`, `missingMask`, `sourceVersions`. ערך חסר נשאר `null`; אין `Number(null)`, אין שימוש ב־`row.score` כ־RVOL. עבור snapshots ישנים עם משמעות לא ידועה, סמן `schema_incompatible` והוצא מאימון, בלי backfill מניחני.
* ודא שכל שדה ששימש דירוג נשמר עם `availableAt <= decisionAt` ותואם בין צורת האימון לצורת ה־live. בזמן ספק נתונים חלקי, חסר או גרסת feature לא תואמת: דירוג baseline לאותו scan, עם reason גלוי.
* השאר `plan`, `d0/d1/d3/d5` ותנועת מניה כיעדים נפרדים. `no_observed_fill` אינו תשואה אפס; `ambiguous`, `needs_data` ו־`null` אינם labels שליליים. יעד ראשי לקידום יוגדר מראש על תוצאות תוכנית ב־filled/resolved ובתרחישי עלות, ויעד משני על תנועת מניה; הצג מכנים נפרדים.

### שלב ב — חלונות, datasets ו־evidence

* שמור `shadowStartedAt`, `trainCutoffAt`, `validationStart/End`, `prospectiveStartAt`, `prospectiveEndAt`, `matureAt`, `policyVersion`, `datasetVersion`, `gateVersion` כעמודות או כחוזה נתונים קשיח וממוספר. עשה migration ממוספר ואידמפוטנטי; שימור מלא של גרסאות, ארכיון ו־audit.
* חשב סשנים מלוח מסחר היסטורי המכסה את **כל** הטווח. `cachedSessionsRange` של חלון חי מוגבל אינו מקור יחיד למדידת שבעה ימים. לוח חסר = `calendar_unavailable` וחסימת קידום. ההשוואה היא לפי סגירת סשנים בפועל, כולל חג ויום מקוצר.
* קבוצת prospective כוללת רק setups עם `decisionAt >= shadowStartedAt`; label נספר רק כשהאופק `d5` הבשיל, `workflowStatus=complete`, כיסוי מחיר תקין, ומידע המקור היה זמין בזמן ההחלטה. המלצות טרום shadow יכולות לשמש train היסטורי בלבד, עם cutoff מוקפא; לא כהוכחה לשבעה ימי ראיות קדימה. ספור setups ייחודיים, ימים וניירות, ולא receipts כפולים.
* שמור snapshots של pool קיים, כולל מועמדות שנדחו אך היו זכאיות, סיבת אי־בחירה, rank, מכסה, דגימה ו־probability. אם אין להן outcome, סמן `unlabeled`; השוואת policy שמחליפה אותן היא `incomplete`, וחסום קידום. אל תיצור דוגמה שלילית משום שמניה לא פורסמה.
* versioned dataset הוא immutable: revision של evaluation יוצר dataset/lineage חדש. שמור checksum, cutoffs, query criteria, גרסאות evaluator/feature, seed, מספר ניסיונות policy וספירות לפי סטטוס. תקן את `labelValue` כך ש־null/NaN/Infinity אינם הופכים לאפס וש־fallback outcome מופעל רק כשמדד כמותי אינו קיים והסטטוס מתאים.

### שלב ג — למידה, אימות והשוואה

* התחל ממודל קטן ופרשני: buckets עם shrinkage לפי אסטרטגיה, השפעה מוגבלת ביחס לדירוג baseline, minimum support לכל bucket, וטיפול מפורש ב־missing. הימנע מסכימת חמישה אפקטים תלויים כאילו הם בלתי תלויים; למד תחילה אפקט אסטרטגיה ומעט אינטראקציות שנבחרו מראש, או כייל את סכום האפקטים על validation. שמור `support`, uncertainty וגרסת מודל לכל אפקט.
* חלק train ו־validation בסדר זמנים, עם purge/embargo של `d5` מלא; אותו `(symbol,session)` אינו מופיע בשני צדדים. אל תבחר hyperparameters על validation נעול או על prospective. מדגם בן 20 המלצות הוא בדיקת זרימה, לא ראיה סטטיסטית ליתרון. קבע מינימום ימים/ניירות/setups מספק מראש, והצג אי־ודאות באשכולות יום ונייר.
* בצע replay של **אותו pool**, עם המכסה, round-robin, נזילות, rotation וסינון אישיים כפי שפעלו בזמן אמת. מדוד baseline מול challenger על setups שלשניהם label תקין; אם coverage של בחירה חלופית חסר, verdict `incomplete`. מדדי gate: כיסוי, שיעור הזדמנות כניסה נצפית, no-fill/ambiguous, R נטו ב־filled/resolved, רגישות optimistic/base/stress לעלות, פיזור ניירות/ימים, כמות המלצות, latency ועומס ספקים. תנועת `d5` תוצג בנפרד ולא תחליף בדיקת יכולת כניסה.
* שמור shadow predictions **לפני** היווצרות labels; מדוד prospective של baseline/challenger על אותו pool לאחר הבשלת `d5`. קידום דורש שבעה סשנים מלאים לפחות וגם כל רצפות האיכות המוקפאות. אם דגימה או נתוני מחיר חסרים, gate נכשל בשם מפורש.
* לאחר קידום, עדכון משקולות לכל היותר פעם בשבוע מסחר; קנרית מוגבלת ורצפת baseline עם מגבלת שינוי סדר/מכסה. אין שינוי זכאות, כניסה, סטופ, יעד, sizing או תדירות API של המסחר החי מתוך המודל. אימון מתבצע ב־worker נפרד, לא בתוך `scan` או בקשת API.

### שלב ד — מעבר מצבים ו־rollback

* `activatePolicy` חייב לפעול בטרנזקציה: בדיקת גרסת dataset/gates/policy, הוצאה של המדיניות הקודמת ממצב פעיל, הפעלת אחת בלבד, רישום `policy_activations` ושמירת `previousPolicyVersion`. הגדר unique partial index או מנגנון שקול המונע יותר מ־`active_limited` אחת. הפעלה חוזרת של אותו אירוע היא idempotent.
* worker בודק מדי סשן כיסוי, תוצאות prospective, מספר המלצות, latency, שגיאות, חסר פיצ'רים ותקינות provenance. הגדר ספים קפואים ותקופת חלון; שבירת hard gate גורמת rollback אטומי לגרסה התקינה הקודמת או baseline. כשל DB באמצע לא מותיר שתי מדיניות פעילות. לאחר restart, שחזר גרסה פעילה יחידה והמשך audit.
* מנע אימון חוזר/הפעלה חוזרת על כל `reviewTick`. השתמש ב־dataset checksum וב־train cutoff כדי להחליט אם יש ראיות חדשות מהותיות; אל תאמן policy חדש בגלל שינוי timestamp בלבד.

### שלב ה — חדשות ואירועי חברה

* הרחב תחילה את Finnhub ו־SEC הקיימים. ב־live pipeline, poll בתקציב קבוע רק עבור מועמדות רלוונטיות, עדיף לפני סינון הבחירה הסופי; שמור את זמן קבלת התשובה בפועל. `publishedAt` של כתבה אינו `firstSeenAt`. חדשות שנאספו אחרי `decisionAt` נשארות הסבר בלבד, גם אם `publishedAt` מוקדם יותר. לא משתמשים בחדשות היסטוריות כדי לבנות בדיעבד feature של החלטת עבר.
* רשומת news קנונית: `provider`, `providerId`, `symbol`, `cik` כשידוע, `source`, `headline` קצר, `url`, `eventAt`, `firstSeenAt`, `fetchedAt`, `availableAt`, `identityConfidence`, `eventType`, `classificationVersion`, `dedupeHash`, `coverageStatus`. שמור מטא־נתונים וקישור; dedupe של כתבות משוכפלות בין ספקים. SEC משויך לפי CIK מאומת. ספק שנכשל = `unknown`, לא “אין חדשות”.
* פיצ'רים התחלתיים שאפשר למדוד: מספר כתבות ייחודיות ב־6/24/48 שעות שהיה ידוע עד `decisionAt`, גיל החדשה האחרונה, סוג אירוע קפוא (דוחות, guidance, מיזוג, הנפקה/דילול, רגולציה, SEC filing), זהות חברה ודגל `news_unknown`. `sentiment` טקסטואלי הוא ניסוי נפרד: גרסת מסווג, confidence, ambiguity, דוגמאות audit ויכולת כיבוי. אין score אוטומטי רק בגלל “יותר חדשות”.
* הוסף קודם ל־dataset ול־shadow scoring; בדוק אם news features מוסיפים ערך **מעבר** לפיצ'רי מחיר/נפח, באותה קבוצת validation/אותו pool ובאותן עלויות. אם אין יתרון יציב, השאר חדשות כהסבר בממשק. `post_hoc_explanation` אינו קלט למודל. הצג למשתמש מקור, שעה, כיסוי ואי־ודאות, ללא ניסוח סיבתי.

## 4. מקורות חינמיים וסדר אימוץ

| מקור | שימוש מוצע | מצב והגבלה | החלטה |
| --- | --- | --- | --- |
| [Finnhub Company News](https://github.com/Finnhub-Stock-API/finnhub-go/blob/master/api/openapi.yaml) | מטא־נתוני ידיעות לפי סימול | המתאם והמפתח כבר קיימים בפרויקט; במסמך הבדיקה הקודם נרשמה תשובת 200 במדגם, אך זכאות, עומק היסטורי וקצב בסביבת הפריסה מחייבים probe מחודש. מוגבל לחברות צפון־אמריקאיות לפי סכמת הספק. | מקור ראשון ל־live snapshot; אל תניח כיסוי מלא או חינמיות מובטחת למפתח. |
| [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | דיווחים וחותמות זמן של חברות אמריקאיות | גישה ציבורית חינמית; [גישה הוגנת](https://www.sec.gov/about/webmaster-frequently-asked-questions) דורשת User-Agent מזוהה ומגבילה ל־10 בקשות לשנייה. התאמת סימול ל־CIK ושעת זמינות בפועל חיוניות. | מקור משלים לאירועים, עם cache וקצב שמרני. |
| [Alpha Vantage NEWS_SENTIMENT](https://www.alphavantage.co/documentation/) | כיסוי חדשות/sentiment חלופי למדגם קטן | התיעוד מתאר endpoint ומפתח חינמי; [הספק מציין](https://www.alphavantage.co/support/) 25 בקשות ביום לרוב datasets, לא התחייבות ש־NEWS_SENTIMENT זמין לכל מפתח/שימוש. | אופציה לניסוי מוגבל בלבד, לאחר probe זכאות, איכות וסדר זמנים. אין חיבור חי כברירת מחדל. |
| [GDELT DOC API](https://gdeltproject.org/data.html) | גילוי הקשר חדשותי רחב | הנתונים וה־JSON API פתוחים, אך זיהוי חברה/סימול וחותמת זמינות לצורכי מסחר אינם מובטחים; יש רעש ושיוך שגוי אפשרי. | מחקר/הסבר בלבד עד הוכחת entity linking ואיסוף prospective. |

אין צורך לקנות API חדש לשלב הראשון. בצע `probe` קטן עם המתאמים הקיימים והרשאות סביבת הפריסה: HTTP status/errorKind, מספר פריטים, טווח, timestamp, קצב, response latency, כיסוי וסיבת חסר; אל תדפיס מפתחות או URL שמכיל token. אם Finnhub אינו מספק כיסוי שימושי, נסה Alpha Vantage על מספר קטן של מניות/ימים עם מפתח שהמשתמש יספק; אל תסמן `blocked-data` לפי תיעוד בלבד. בדוק גם תנאי שימוש לפני שמירת תוכן מעבר למטא־נתונים ולפני הרחבת שימוש מחוץ לחשבון האישי.

## 5. מטריצת בדיקות מחייבת

| תחום | תרחיש | תוצאה נדרשת |
| --- | --- | --- |
| חלון prospective | 7 סשנים מאז תחילת shadow, 20 labels ישנים, 0 labels חדשים | `shadow`; שער `prospective_evidence_insufficient`. |
| לוח מסחר | סוף שבוע, חג, יום קצר, DST, cache חי שאינו מכסה את החלון | סופרים סגירות אמיתיות; כשאין לוח — אין קידום. |
| הבשלת אופק | המלצה ביום השביעי עם `d5` שטרם הבשיל | אינה נספרת ב־resolved; 7 ימים לבדם לא מפעילים. |
| בידוד נתונים | שני users מקבלים אותו setup; שני receipts ו־revision מאוחר | דוגמת אימון אחת, lineage מפורש, אין דליפת נתוני משתמש. |
| פיצ'רים | `rvol=null`, `score=RSI/gap`, `adv20=null`, schema ישן | missing נשאר missing; `score` אינו RVOL; fallback ל־baseline כשנדרש. |
| תוויות | `no_observed_fill`, `ambiguous`, `metrics.rNet=null`, `needs_data` | אין המרה לאפס/הפסד; מדד כיסוי ומכנה תוצאה נפרדים. |
| אימון | דוגמה מאוחרת בתום train; אותו נייר/סשן סביב הגבול | purge/embargo `d5`; אין דליפה ל־validation. |
| replay | challenger בוחר shadow candidate בלי label | ההשוואה `incomplete`; אי אפשר לקדם. |
| איכות | coverage וכמות עוברים אך validation או עלות stress נכשלים | נשאר `shadow`; סיבה ומטריקות נשמרות. |
| מעבר מצבים | שתי הפעלות מקבילות, retry, crash באמצע טרנזקציה | מדיניות פעילה יחידה; audit idempotent; אין מצב ביניים. |
| rollback | כיסוי/latency/תוצאות שוברים סף, ואז restart | rollback אטומי; גרסת fallback נשמרת ונקראת אחרי restart. |
| חדשות | כתבה פורסמה לפני החלטה אך נשלפה אחריה | `post_hoc_explanation`/`availability_unknown`; אינה feature. |
| חדשות | כתבה נשלפה בזמן, `eventAt` לפני החלטה, CIK תואם | `decision_evidence` עם timestamp ומקור; feature נבנה רק מה־snapshot. |
| חדשות | כותרת כפולה, סימול דו־משמעי, 429/403, רשימה ריקה | dedupe; זהות לא ברורה/כשל ספק אינם “אין חדשות”. |
| API ו־UI | מעבר shadow→active→rollback | מוצגים גרסאות, זמן, מספר סשנים, מכנים, gates שנכשלו ומקור החדשות; ללא הבטחת רווח. |

הרץ את בדיקות השרת וה־build הקיימים; הוסף בדיקות אינטגרציה על SQLite זמני, כולל restart. בצע בדיקת worker מול API מקומי אמיתי ובדיקת דפדפן לפאנל feedback ולפרטי המלצה. בצע עומס לפי תקציב הפריסה: לפחות ריצה מוגבלת עם dataset גדול, ובדיקת 30 דקות/מיליון receipts אם סביבת הבדיקה מאפשרת; דווח במדויק מה הורץ ומה לא. פרוב נתונים חי אינו בדיקת רווחיות. בדוק backup/restore של SQLite ו־lineage לפני הפעלה חיה.

## 6. תנאי קבלה ודוח סיום ל־5.5

סדר מסירה: (1) סגרי הפעלה ופיצ'רים קנוניים; (2) חלונות ו־datasets; (3) replay/validation; (4) מעבר מצבים ו־rollback; (5) חדשות במצב shadow; (6) בדיקות, probes, תיעוד. לכל שלב ציין קבצים, migration, בדיקות וראיות. אין לדלג לשלב הבא כאשר בדיקת מניעת look-ahead או ייחוד מדיניות פעילה נכשלת.

בדוח הסופי הצג בנפרד: מה מומש; אילו בדיקות עברו ועם כמה דוגמאות/סשנים/ניירות; מה נבדק מול ספק חי ובאיזו סביבת הרשאות; האם קיימת מדיניות פעילה בפועל ומדוע; מה נותר `shadow` או חסום; מגבלות כיסוי החדשות והמדידה; מה נדרש לפריסה. ציין במפורש ש־unit tests, בדיקה מקומית ו־replay אינם הוכחה לדיוק משופר, רווחיות או מוכנות production.

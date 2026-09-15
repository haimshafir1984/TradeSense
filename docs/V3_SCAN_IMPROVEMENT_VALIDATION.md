# אימות שיפור הסריקה האוטומטית v3

נבדק מקומית ב־15.09.2026. זהו דוח הנדסי לתשתית ולזרימת מועמדות, לא מחקר רווחיות ולא אישור לפרודקשן.

## מה מומש

- universe מאוזן עד 2,000 סימולים בשלוש מדרגות ADV, מכסות ביחס 30/40/30, בחירת 80% לפי ADV ורוטציה אלפביתית ביתרה. פרסום דור חדש מותנה ב־build שלם; כשל אינו מחליף את המאגר האחרון ואינו מקדם cursor.
- בחירה עד 120: 100 מקומות אסטרטגיה (חלוקת יעד 60/40 בין יומי/נדנדה, והעברת יתרות) ועוד יעד רוטציה של שישית מהתקרה. נוסף round-robin לפי אסטרטגיה ומדרגת נזילות; מועמד swing יומי יכול להגיע לבדיקה בלי snapshot טרי, אך בדיקת המחיר החי נשארת לפני יצירת איתות. `legacy` משמר את שער freshness הקודם.
- IEX ו־SIP תוך־יומי נשמרים במפתחות נפרדים. SIP מוגבל ל־40 מועמדות שנבחרו, מקבל cutoff מושהה של 16 דקות, bars פתוחים מסוננים, ו־RVOL אפשרי רק כאשר RVOL IEX חסר. ברירת המחדל shadow: נשמרת החלטה קומפקטית בלבד, ללא signal/position/push/watch. `enabled` מוסיף provenance וגרסת data-variant; `off` משבית את מסלול SIP האופציונלי.
- שיתוף תקציב בקשות Alpaca עם תקרה 150/min, שמירת מרווח לשעון/לוח, לכל היותר 20 בקשות ממתינות, עד שתי בקשות היסטוריה פעילות, timeout של 20 שניות, עד שני retries על כשלים זמניים וללא retry על 403. SIP 403 נשמר כמושבת עד יום המסחר הבא.
- checkpoints יומיים נשארים קומפקטיים; retention לאבחון שומר attempts עד 7 ימים/60,000, aggregates ל־30 יום ועד 1,000 החלטות shadow. eviction של היסטוריית 5 דקות מבוסס metadata ומוחק לפי `record.id`; התקציב משותף לשני feeds (500 רשומות, עד 100 SIP) והסימולים הפעילים מוגנים.
- UI מציג את מצב shadow באופן שאינו נראה כהמלצה, provenance של SIP מושהה באיתות מאופשר, והסבר ידידותי לחוסר מועמדות/נתונים. נוספו משתני סביבה והוראות rollback ל־legacy+off.

## בדיקות שבוצעו

- Baseline לפני שינוי: 315 בדיקות שרת עברו ו־client build עבר.
- מצב סופי: `npm test` — **320 עברו, 0 נכשלו**; `npm run build` — הצליח.
- בדיקות ממוקדות חדשות: חלוקת 600/800/600 על 3,500 זכאיות, largest-remainder ו־deficit determinism, cutoff 10:02 NY→09:45, דחיית bar שמתחיל ב־cutoff, חסימת RVOL לפני 15 דקות, ומועמד swing ללא snapshot ב־balanced לעומת legacy.
- Replay סינתטי זהה ל־legacy ול־balanced ב־12 זמני סריקה: 80 סימולים בפ fixture, 3 סימולי swing עם snapshot לא טרי הגיעו לרשימת בדיקת swing ב־balanced ולא ב־legacy בכל 12 הריצות. Fixture שלילי ללא פיצ'רים החזיר **0 מועמדים בעלי אסטרטגיה פעילה**. זהו replay של shortlist בלבד, לא אישור trigger/signal.
- Stress מבודד עם ספק מדומה: 2,000 פיצ'רים, 500 רשומות היסטוריה תוך־יומית (400 IEX/100 SIP), 1,560 bars לרשומה, 12 סריקות חמות; שיא RSS **230.8MB**, גידול tail **2.9MB**, 80 בקשות daily קרות/0 חמות. עברו מגבלת 350MB ומדד צמיחה של 50MB בסקריפט. הבדיקה אינה מדמה תמהיל עומס מלא של ספק HTTP.
- בדיקת API ודפדפן מקומית: `/api/health` החזיר `ok:true`; יצירת session, התחברות בדפדפן וטעינת dashboard אותנטי הצליחו; ה־dashboard הציג שש אסטרטגיות. השרת הורץ עם `AUTOPILOT_DISABLED=true`, לכן לא בוצעה סריקת Alpaca חיה. שתי/שלוש תגובות 401 ב־console היו מה־polling שלפני התחברות; אחרי התחברות לא נרשמה שגיאת API חדשה.
- לא בוצעה קריאת Alpaca חיה במהלך אימות זה. לכן אין כאן מדידת זמינות SIP/coverage עדכנית מהחשבון ואין טענה על feed entitlement.

## מה עדיין לא הושלם / חסום

1. **Replay acceptance מלא חסר:** ה־12-point replay משווה shortlist, לא אותו תרחיש של זמני הגעת snapshot/כשלים/שני feeds עד לתוצאת `evaluate` ו־live-price freshness. ה־positive fixture מראה הגעה חדשה לבדיקה יומית, לא setup מאושר/איתות תקין; מסלול fallback SIP חיובי ושלילי עדיין דורש fixtures end-to-end.
2. **בדיקת עומס סופית דורשת הרצה חוזרת** אחרי השינויים האחרונים ב־attempt retention וב־adapter. גם כשהיא תעבור, צריך להוסיף harness דטרמיניסטי של pagination, 429/Retry-After, timeout, overlap, עמדות פעילות, תור ומדידת 150 בקשות/דקה — הסקריפט הנוכחי מכסה בעיקר RSS, 2,000 features ו־12 סריקות.
3. **אין אימות Linux/Render** או בדיקת RSS בתנאי 512MB על סביבת Linux. נדרשת לפני rollout.
4. **לא אומתו מקרי לוח מלאים** לחגים, יום מקוצר, הרחבת warmup ל־40 ימים, ו־DST מעבר לדוגמת cutoff הנוכחית. אם 26 ימים אינם מספקים 14 סשנים, כרגע אין הרחבה אוטומטית ל־40.
5. **גבולות תקציב וזיכרון לא עברו בדיקות fault-injection:** אין עדיין בדיקה המוכיחה תחת concurrency/retry שה־reserve ל־monitor נשמר בכל תמהיל, או ש־RSS ב־300/350MB מפסיק/מחדש עבודה בדיוק אחרי שלוש דגימות. בקשות שכבר נשלחו אינן מתבטלות מייד כשה־scan budget מסתיים; נמנעת שליחת batch אופציונלי נוסף.
6. **לא נבדקו לאורך session מלא** התקדמות cursor אחרי restart, כשל באמצע generation עם ספק חלקי, retention על 60k/1k רשומות, הגנת holdings ב־eviction, או קצב בחירה של 120 עם תערובת מלאה של אסטרטגיות פעילות. נדרשות בדיקות אינטגרציה נוספות לפני production.
7. אין תוצאת פריסה/חמישה ימי איסוף, ואין מסקנה על רווחיות או readiness לפרודקשן. `enabled` נשאר opt-in; ברירת המחדל `balanced`+`shadow`.

## הרצה מקומית ו־rollback

ברירות המחדל: `AUTOPILOT_SCAN_PROFILE=balanced`, `AUTOPILOT_SIP_CONTEXT_MODE=shadow`, `AUTOPILOT_SIP_CONTEXT_MAX=40`, `AUTOPILOT_API_RPM_BUDGET=150`. Rollback: `AUTOPILOT_SCAN_PROFILE=legacy` וגם `AUTOPILOT_SIP_CONTEXT_MODE=off`. אין למחוק או לשנות נתוני משתמש/עסקאות לצורך rollback.

הרצות: `npm test` מתוך `server/`; `npm run build` מהשורש; `node scripts/compareV3Selection.js` ו־`node scripts/stressV3Memory.js` מתוך `server/`.

לא בוצעו commit, push או deploy.

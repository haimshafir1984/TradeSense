# Vibe-Trading On-Demand Integration ("רמה 2")

תאריך: 2026-07-18
סטטוס: מומש
קשר: `docs/SPEC_VIBE_TRADING_LAB.md`, `docs/BACKTEST_FINDINGS.md`

## מה זה

שתי כפתורים בטאב "סריקת שוק", **ביוזמת המשתמש בלבד** - לא אוטומטי על אף סריקה:

1. **"בדוק היסטורית"** ליד כל מניה בתוצאות - שואל: מה המניה הזו עצמה עשתה בעבר (2 שנים) כשהיא הראתה תבנית דומה לחוקי האסטרטגיה הנבחרת.
2. **"בדוק תאוריה היסטורית"** ליד סרגל המטא (מעל התוצאות) - שואל: איך חוקי האסטרטגיה הנבחרת ביצעו על מדגם קבוע של מניות (3 שנים) - אותה שיטה שהניבה את התוצאות ב-`docs/BACKTEST_FINDINGS.md`.

שני הכפתורים קוראים לשרת (`vibeTradingService.js`), שמריץ תהליך Python חיצוני (`vibe-trading run -p "..." --no-rich`) בתיקיית ה-lab הנפרדת ומחזיר את הפלט כטקסט למודל בקליינט.

## היקף - חשוב

- **מקומי בלבד.** ‏Vibe-Trading לא מותקן ב-Render. התכונה מוסתרת לגמרי (`GET /api/backtest/status` מחזיר `{enabled: false}`) אלא אם `VIBE_TRADING_ENABLED=true` מוגדר - וזה לא מוגדר ב-Render, ולא צריך להיות.
- **Feature flag:** `VIBE_TRADING_ENABLED=true` + `VIBE_TRADING_LAB_PATH=<נתיב לתיקיית ה-lab>` ב-`.env` המקומי.
- **אין אוטומציה.** שום קוד לא קורא ל-`vibeTradingService` מתוך `scannerService.js`/`analyzeMarket` - זה נגיש רק דרך שני ה-endpoints הייעודיים, וכל אחד מהם מריץ רק בתגובה ללחיצת משתמש בקליינט.
- **מסחר חי לא נגיש מכאן בכלל.** ה-prompt שנשלח תמיד כולל הוראה מפורשת לא לגעת ב-connectors, וגם ברמת ה-CLI עצמו (`vibe-trading run -p ...`) אין שום נתיב לחיבור broker - זה דורש פקודות `connector authorize/start` נפרדות שהקוד הזה אף פעם לא קורא להן.
- **Single-flight guard.** ריצה אחת בכל רגע נתון (`runInFlight`) - לחיצה נוספת בזמן ריצה מקבלת הודעה ברורה במקום תור/עומס.
- **Timeout:** 3 דקות לכל ריצה.

## קבצים

- `server/src/services/vibeTradingService.js` - הלוגיקה: בניית prompt, spawn, timeout, single-flight, feature flag.
- `server/src/routes/backtest.js` - שלושה endpoints: `GET /status`, `POST /stock`, `POST /theory`.
- `client/src/App.jsx` - הכפתורים + `BacktestReportModal` שמציג את הדוח כטקסט גולמי.
- `server/test/vibeTradingService.test.js` - בודק את מצב "כבוי" (ברירת מחדל) ואת מצב "קובץ הרצה חסר", בלי לגעת בתהליך אמיתי.

## תקלה שנמצאה ותוקנה

הפלט הגולמי מ-`vibe-trading run` כולל קודי ANSI (צביעת טרמינל דרך Rich) שהודפסו כטקסט גולמי בממשק. תוקן על ידי הוספת `--no-rich` לפקודת ה-CLI.

**עדכון (2026-07-18):** `--no-rich` לא כיסה את כל הפלט - טבלת ה-"Preflight Check" עדיין הדפיסה קודי ANSI גולמיים גם איתו (נצפה בפועל ב"בדוק היסטורית" על PANW). התיקון המלא: `vibeTradingService.js` מסיר קודי ANSI בעצמו (`stripAnsiCodes`, regex על `\x1B\[...`) מכל פלט (stdout ו-stderr) לפני שהוא מוחזר ל-UI, במקום להסתמך אך ורק על דגל ה-CLI.

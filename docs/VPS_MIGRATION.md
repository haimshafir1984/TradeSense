# מעבר מ־Render ל־VPS

> **שרת שמריץ Dokploy או Traefik (כמו ה־VPS שלך)?** משתמשים במסמך `docs/DOKPLOY_DEPLOYMENT.md` ולא ב־`deploy/vps/setup.sh`.

המטרה: להפסיק לשלם על שירות ה־Backend והדיסק ב־Render. האתר (הלקוח) וה־API ירוצו על אותו VPS מאחורי Caddy עם HTTPS אוטומטי, תחת שם דומיין אחד. קבצי ההפעלה נמצאים ב־`deploy/vps/`.

אין קוד אפליקציה ששונה. נוסף רק `server/scripts/backupDb.js` (`npm run db:backup --workspace server`), גיבוי עקבי של ה־SQLite שרץ גם כשהשרת פעיל.

## מה נדרש מראש

- **שם דומיין או תת־דומיין** (למשל `trade.example.com`). בלי HTTPS התראות Push לא עובדות מחוץ ל־localhost.
- גישת SSH ל־VPS (Ubuntu 24.04).
- ערכי המפתחות מדשבורד Render, בלשונית Environment. מעתיקים אותם ישירות לקובץ בשרת ולא דרך צ'אט.

## שלבים

1. **DNS.** ב־Cloudflare מוסיפים רשומת `A` מהדומיין ל־IP של ה־VPS, במצב **DNS only** (ענן אפור) עד שהתעודה מונפקת.
2. **התקנה.** ב־VPS כ־root:
   ```bash
   git clone https://github.com/haimshafir1984/TradeSense.git /opt/tradesense
   cd /opt/tradesense
   bash deploy/vps/setup.sh trade.example.com
   ```
   אם המאגר פרטי, משתמשים ב־deploy key או ב־token. הסקריפט מתקין Node 24 בתיקייה פרטית (`/opt/node24`, בלי לשנות את ה־Node של המערכת) ואת Caddy, בונה את האתר, ורושם שירות `tradesense` **בלי להפעיל אותו**. הוא נעצר אם תוכנה אחרת כבר מחזיקה את פורטים 80/443, ואינו מפעיל חומת אש (`ufw`) שכבויה כדי לא לחתוך את הפרויקט השני. פירוט בשיקולים לשרת משותף: `docs/VPS_MIGRATION_HANDOFF.md`.
3. **הגדרות.** עורכים את `/etc/tradesense/tradesense.env` ומדביקים את `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `PUSH_CONTACT` ושאר ההגדרות שיש ב־Render (`AUTOPILOT_*` אם הוגדרו שם).
4. **העברת הנתונים (מומלץ).** שומרת על עסקאות, הגדרות, הלמידה, מפתח ה־VAPID והקוד שלך.
   - ב־Render, דרך Shell או SSH של השירות:
     ```bash
     cd /opt/render/project/src/server && node scripts/backupDb.js /var/data/export.sqlite --compact
     ```
     (`--compact` מכווץ את העותק בלבד ולא את המסד החי.)
   - מעתיקים אותו ל־VPS. אם SSH ל־Render מוגדר (מפתח ציבורי תחת Account Settings): ב־VPS
     ```bash
     scp srv-XXXX@ssh.<region>.render.com:/var/data/export.sqlite /var/lib/tradesense/autopilot.sqlite
     chown tradesense:tradesense /var/lib/tradesense/autopilot.sqlite
     ```
   - בלי העברה השרת מתחיל ממסד ריק: אין עסקאות ואין היסטוריית למידה, ותבחר קוד כניסה חדש.
5. **הפעלה.** `systemctl start tradesense`. בלוג (`journalctl -u tradesense -f`) צריך להופיע `SQLite path: /var/lib/tradesense/autopilot.sqlite` ו־`Autopilot scheduler started`. בדיקה: `curl https://trade.example.com/api/health`.
6. **חיתוך.** מיד אחרי שה־VPS עלה, **משהים את שירות ה־Backend ב־Render** (Suspend). שני שרתים שרצים יחד שולחים התראות כפולות, והעבודה שנעשתה בין הייצוא לחיתוך נשארת ב־Render, כמה דקות לכל היותר.
7. **טלפון.** נכנסים לכתובת החדשה עם הקוד, ומחברים התראות מחדש. מנוי Push קשור לכתובת האתר, ולכן מנוי מהכתובת הישנה לא יעבוד. אם אחרי החיבור אין התראה, מבטלים את הרשאת ההתראות לאתר בדפדפן ומחברים שוב.
8. **סיום ב־Render.** אחרי כמה ימים תקינים מוחקים את שירות ה־Backend ואת הדיסק. אתר ה־Static שם חינמי, ואפשר להסיר גם אותו.

## תפעול שוטף

| פעולה | פקודה |
|---|---|
| עדכון גרסה | `bash /opt/tradesense/deploy/vps/update.sh` |
| לוגים | `journalctl -u tradesense -f` |
| הפעלה מחדש | `systemctl restart tradesense` |
| גיבוי ידני | `sudo -u tradesense bash /opt/tradesense/deploy/vps/backup.sh` |
| איפוס קוד כניסה | להגדיר `AUTOPILOT_CODE_RESET` בקובץ ההגדרות ולהפעיל מחדש |

גיבוי אוטומטי רץ כל לילה ב־03:17 אל `/var/backups/tradesense`, ונשמרים 14 ימים. הוא נמצא על אותה מכונה, ולכן הוא לא מגן מפני תקלה של ה־VPS: מפעילים את Auto Backup של Contabo או מעתיקים מדי פעם קובץ אחד למחשב שלך.

שחזור: `systemctl stop tradesense`, מעתיקים גיבוי ל־`/var/lib/tradesense/autopilot.sqlite`, `chown tradesense:tradesense`, `systemctl start tradesense`.

## סיכונים

- שרת יחיד ללא יתירות. התהליך מופעל מחדש אוטומטית (`Restart=always`), אבל השבתת ה־VPS מפילה גם את ההתראות.
- הפרויקט השני על אותו VPS מתחרה על זיכרון ו־CPU.
- ה־VPS חשוף לאינטרנט. נשארים רק פורטים 22, 80, 443, והמפתחות בקובץ שנגיש ל־root בלבד (`chmod 600`).
- התקנה לא נבדקה על Ubuntu אמיתי. סקריפט ההתקנה נכתב בלי הרצה, ולכן מריצים אותו ובודקים את הפלט שלב אחר שלב.

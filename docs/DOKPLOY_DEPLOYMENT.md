# פריסת TradeSense ב־Dokploy (השרת המשותף עם FlowsBiz)

מסמך זה מחליף את מסלול `deploy/vps/setup.sh` עבור ה־VPS שבו כבר רצים Dokploy ו־Traefik. **לא מריצים** `setup.sh` ולא מתקינים Caddy על השרת הזה: פורטים 80/443 תפוסים על ידי Traefik, וכל שינוי ידני בו או ב־Docker עלול להפיל את FlowsBiz.

## התוכנית אושרה, עם תיקונים

התוכנית (Dokploy כפרויקט חדש, Traefik הקיים, volume לקובץ SQLite, חיתוך מבוקר) נכונה. הפרטים הבאים תוקנו או נוספו:

1. **אין צורך ב־`APP_DOMAIN`.** הוא שימש רק את סקריפטי `deploy/vps`. מגדירים רק `CLIENT_ORIGIN=https://trade.flowsbiz.com` (בלי לוכסן בסוף). ערך שגוי גורם ל־403 בכל בקשת POST.
2. **אין צורך ב־build arg לכתובת ה־API.** האתר בגרסת production פונה כברירת מחדל לאותו origin (`/api/...`), והשרת עצמו מגיש את האתר. הדבר נבדק מקומית: כניסה בדפדפן עברה דרך `POST /api/autopilot/session` על אותו פורט.
3. **ריפו מוכן לאפליקציה אחת.** נוסף `Dockerfile` (בנייה בשני שלבים) ו־`.dockerignore`. Express מגיש את `client/dist` אם הוא קיים. בלי `client/dist` (פיתוח ושירות ה־API ב־Render) ההתנהגות לא משתנה.
4. **רפליקה אחת בלבד, והחלפה בסדר stop-first.** התהליך כולל מתזמן שמטפל בהתראות ועובד מול קובץ SQLite יחיד. שני מופעים במקביל, גם לרגע בזמן עדכון, יוצרים התראות כפולות. ב־Swarm ברירת המחדל היא `stop-first`, אבל מוודאים זאת בהגדרות Dokploy (Advanced, Cluster/Swarm).
5. **הרשאות על ה־volume.** הקונטיינר רץ כמשתמש `node` (uid 1000). תיקיית המסד בשרת חייבת להיות שלו, אחרת השרת ייפול לאחסון זמני ויציג את הבאנר האדום.
6. **ריצת ניסיון בלי מנוע.** בפריסה הראשונה מגדירים `AUTOPILOT_DISABLED=true`, כדי לוודא בנייה, דומיין ו־HTTPS בלי שליחת התראות כפולות לצד Render. שים לב: השורה `Autopilot scheduler started` בלוג מופיעה גם כשהמנוע כבוי ולכן אינה הוכחה. הבדיקה האמיתית היא שבאתר מופיע "אין כרגע חיבור פעיל למנוע".
7. **גישה לריפו.** אם המאגר פרטי, Dokploy צריך חיבור GitHub או deploy key (לקריאה בלבד).

## הגדרות ב־Dokploy

| הגדרה | ערך |
|---|---|
| Project | `TradeSense` (חדש. לא נוגעים בפרויקטים הקיימים) |
| Application, Provider | GitHub, ענף `main` |
| Build Type | `Dockerfile`, נתיב `Dockerfile`, context `.` |
| Domain | Host `trade.flowsbiz.com`, Path `/`, Container Port `4000`, HTTPS פעיל, Certificate: Let's Encrypt |
| Mounts | Bind Mount: Host Path `/var/lib/tradesense`, Mount Path `/data` |
| Replicas | `1` |
| Health check | `GET /api/health` בפורט 4000 (ה־Dockerfile כולל HEALTHCHECK) |
| Auto Deploy | כבוי עד שהמערכת יציבה, ואז לפי החלטה |

הכנת התיקייה בשרת (פעם אחת, כ־root):

```bash
mkdir -p /var/lib/tradesense/backups
chown -R 1000:1000 /var/lib/tradesense
```

### משתני סביבה (מדביקים בעצמך מלשונית Environment ב־Render)

חובה: `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `PUSH_CONTACT`, וכל משתני `AUTOPILOT_*` שהיו ב־Render.

מוגדרים כאן במפורש: `CLIENT_ORIGIN=https://trade.flowsbiz.com`, `NODE_ENV=production`. הנתיבים `AUTOPILOT_DB_PATH=/data/autopilot.sqlite` ו־`PORTFOLIO_STORE_FILE_PATH=/data/portfolio.json` כבר מוגדרים בתוך ה־Dockerfile.

אין להדביק מפתחות בצ'אט.

## DNS (Cloudflare)

רשומה אחת בלבד: `A`, שם `trade`, ה־IPv4 של ה־VPS, **DNS only** (ענן אפור), TTL אוטומטי. בלי `AAAA`. לא נוגעים ב־MX/TXT/SPF, Email Routing, R2 או nameservers. לפני כן בודקים שאין `CAA` שחוסם `letsencrypt.org`. Traefik מנפיק את התעודה לבד דרך אתגר HTTP בפורט 80, וזה עובד בענן אפור.

## סדר הביצוע

1. **רשומת DNS ופריסת ניסיון.** מגדירים `AUTOPILOT_DISABLED=true`, מפרסמים, ובודקים: `https://trade.flowsbiz.com` נטען ב־HTTPS, `/api/health` מחזיר `{"ok":true}`, ואין באנר אדום. עדיין בלי להעביר נתונים.
2. **ייצוא מ־Render.** ממש לפני החיתוך, בשירות ה־Backend שם:
   ```bash
   cd /opt/render/project/src/server
   node scripts/backupDb.js /var/data/export.sqlite --compact
   ```
   אין להעתיק את קובץ המסד החי ישירות. אין להעלות את הייצוא לשירותי שיתוף: הוא מכיל את המפתח הפרטי של ההתראות ואת ה־hash של קוד הכניסה.
3. **העתקה ל־VPS.** מעבירים את הקובץ (`scp` מה־VPS דרך SSH של Render) אל `/tmp/export.sqlite` בשרת.
4. **עצירה, החלפה, הפעלה.**
   - ב־Dokploy: Stop לאפליקציה (חייבים לעצור, כדי לא להחליף קובץ שפתוח).
   - בשרת:
     ```bash
     rm -f /var/lib/tradesense/autopilot.sqlite-wal /var/lib/tradesense/autopilot.sqlite-shm
     cp /tmp/export.sqlite /var/lib/tradesense/autopilot.sqlite
     chown 1000:1000 /var/lib/tradesense/autopilot.sqlite
     ```
   - ב־Dokploy: מסירים את `AUTOPILOT_DISABLED` ומפעילים (Start/Deploy).
5. **בדיקות.** לוגים עם `SQLite path: /data/autopilot.sqlite` ובלי `EPHEMERAL STORAGE` או `disk is full`; כניסה עם הקוד הקיים והנתונים הישנים מופיעים.
6. **מיד לאחר מכן: Suspend ל־Web Service ב־Render.** שני שרתים פעילים שולחים התראות כפולות.
7. **טלפון.** פותחים את הכתובת החדשה, מוסיפים למסך הבית ומחברים התראות מחדש. אם בדיקה לא מגיעה, מבטלים את הרשאת ההתראות לאתר בדפדפן ומחברים שוב.

## גיבוי

```bash
# בשרת, כ־root. השם הוא חלק משם הקונטיינר/שירות ב־Dokploy (docker ps)
bash /path/to/TradeSense/deploy/dokploy/backup.sh tradesense
```

לתזמון יומי מוסיפים שורת cron למשתמש root (`17 3 * * *`). הגיבוי נכתב ל־`/var/lib/tradesense/backups` ונשמר 14 ימים. הוא על אותה מכונה ולכן לא מחליף עותק חיצוני (Auto Backup של Contabo, או עותק ידני מדי פעם).

## בדיקות קבלה לפני מחיקת דבר ב־Render

1. `https://trade.flowsbiz.com` נטען ב־HTTPS בלי אזהרה.
2. `/api/health` מחזיר `{"ok":true}`.
3. כניסה עם הקוד הקיים מצליחה והנתונים הישנים נראים.
4. אין באנר אדום ואין `EPHEMERAL STORAGE` או `disk is full` בלוג.
5. התראת בדיקה מגיעה לטלפון.
6. ביום מסחר ה"סריקה האחרונה" מתעדכנת.
7. גיבוי ראשון נוצר ב־`/var/lib/tradesense/backups`.
8. FlowsBiz ושאר האפליקציות ב־Dokploy ממשיכות לעבוד כרגיל.

רק אחר כך מוחקים ב־Render את ה־Web Service ואת הדיסק (מחיקת הדיסק סופית).

## חזרה אחורה

בלי למחוק את Render: מבטלים Suspend, ועוצרים את האפליקציה ב־Dokploy. ככל שעובר זמן הנתונים מתפצלים, ולכן ההחלטה צריכה להיות מוקדמת.

## כללי בטיחות לשרת המשותף

- לא מפעילים מחדש את Docker, לא עוצרים את `dokploy-traefik`, לא עושים `docker swarm leave` ולא `docker service rm`.
- לא עורכים ידנית את `/etc/dokploy/traefik`. כל הגדרת דומיין נעשית דרך ה־UI של Dokploy.
- לא נוגעים בפרויקטים, בשירותים או ב־volumes של FlowsBiz.

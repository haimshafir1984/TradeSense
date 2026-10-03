# מעבר TradeSense מ־Render ל־VPS: מדריך מפורט

> **שרת שמריץ Dokploy או Traefik (כמו ה־VPS שלך)?** משתמשים במסמך `docs/DOKPLOY_DEPLOYMENT.md` ולא ב־`deploy/vps/setup.sh`.

מסמך זה נועד למי שמבצע בפועל את המעבר. ההוראות הקצרות נמצאות ב־`docs/VPS_MIGRATION.md`, וקבצי ההפעלה ב־`deploy/vps/`. כאן ההסבר המלא: מה קיים, מה משתנה ברמת הדומיין וברמת האחסון, ואילו סיכונים להכיר לפני שמתחילים.

חשוב: סקריפט ההתקנה (`deploy/vps/setup.sh`) נכתב ונבדק רק מבחינת תחביר. הוא לא הורץ על Ubuntu אמיתי. מריצים אותו שלב אחר שלב, ובכל תוצאה לא צפויה עוצרים ובודקים.

## 1. המצב היום והמצב המבוקש

| רכיב | היום | אחרי המעבר |
|---|---|---|
| ה־API ומנוע הסריקה וההתראות | Render, Web Service בשם `tradesense-354s` (בתשלום) | תהליך Node על ה־VPS (שירות systemd) |
| בסיס הנתונים | קובץ SQLite על דיסק קבוע של Render, `/var/data/autopilot.sqlite` (בתשלום) | `/var/lib/tradesense/autopilot.sqlite` על ה־VPS |
| האתר (React) | Render, Static Site בשם `tradesense-frontend-0i8a` (חינמי) | קבצים סטטיים ש־Caddy מגיש מה־VPS |
| כתובת | `tradesense-frontend-0i8a.onrender.com` | `https://trade.flowsbiz.com` (או שם אחר לבחירה) |
| HTTPS | Render | Caddy, תעודה אוטומטית מ־Let's Encrypt |

מה עולה כסף ב־Render ויפסיק אחרי המעבר: ה־Web Service והדיסק הקבוע. אתר ה־Static חינמי.

המבנה אחרי המעבר: דפדפן אל Caddy בפורט 443. כל בקשה ל־`/api/*` מועברת אל Node בכתובת `127.0.0.1:4000`, וכל השאר מוגש כקבצי אתר מהתיקייה `client/dist`. כתובת אחת לאתר ול־API, ולכן אין בעיית CORS.

## 2. ברמת הדומיין (Cloudflare)

### מה קיים

הדומיין `flowsbiz.com` רשום ב־Cloudflare (תוכנית Free, מצב Active) ומשמש פרויקט אחר: יש בו Email Routing ובאקט R2 לגיבוי. לכן הכלל הוא להוסיף רשומה אחת בלבד, **לא לשנות nameservers ולא לגעת ברשומות קיימות** (MX, TXT, SPF ושאר). שינוי כזה עלול להפיל את המייל של הפרויקט האחר.

### מה להוסיף

ב־Cloudflare, באזור `flowsbiz.com`, תחת DNS ואז Records, מוסיפים רשומה אחת:

| שדה | ערך |
|---|---|
| Type | `A` |
| Name | `trade` (נוצר `trade.flowsbiz.com`; אפשר שם אחר) |
| IPv4 address | ה־IP של ה־VPS (מופיע בלוח הבקרה של Contabo, שם צריך לוודא אותו) |
| Proxy status | **DNS only** (ענן אפור) |
| TTL | Auto |

לא מוסיפים `AAAA` (IPv6). זה מקטין את האפשרות לתקלות, ו־IPv4 מספיק.

### בדיקות לפני ואחרי

1. לפני ההוספה לוודא שאין כבר רשומה בשם `trade`, ואין רשומת `*` (wildcard) שתתנגש. רשומה ספציפית גוברת על wildcard, אבל כדאי לראות מה קיים.
2. לבדוק אם קיימות רשומות `CAA` בדומיין. אם כן, חייבות לאפשר `letsencrypt.org`, אחרת Caddy לא יוכל להנפיק תעודה.
3. אחרי השמירה, מהמחשב: `nslookup trade.flowsbiz.com`. התשובה צריכה להיות ה־IP של ה־VPS. ההפצה בדרך כלל לוקחת דקות.

### למה DNS only ולא Proxied

כשהענן כתום, Cloudflare עומד בין הדפדפן לשרת. זה עובד, אבל דורש להגדיר ב־Cloudflare את מצב SSL/TLS לערך `Full (strict)`. אחרת נוצרת לולאת הפניות. DNS only הוא הדרך הפשוטה, עם פחות נקודות כשל. מעבר ל־Proxied אפשרי אחרי שהכול עובד, ורק בתנאי ש־SSL/TLS הוא `Full (strict)`.

### מה משתנה בגלל הכתובת החדשה

- `CLIENT_ORIGIN` בקובץ ההגדרות של השרת חייב להיות בדיוק `https://trade.flowsbiz.com`, בלי לוכסן בסוף. השרת דוחה (403, "מקור בקשה לא מורשה") בקשות שאינן GET ממקור אחר.
- בבניית האתר מוגדר `VITE_API_BASE_URL=https://trade.flowsbiz.com`. הסקריפטים `setup.sh` ו־`update.sh` עושים את זה אוטומטית מתוך `APP_DOMAIN`.
- הכתובת הישנה ב־Render תפסיק לעבוד אחרי כיבוי השירות. צריך להחליף סימניות ואייקון במסך הבית בטלפון.
- מנוי ההתראות בדפדפן קשור לכתובת האתר, ולכן חייבים לחבר התראות מחדש בכתובת החדשה.

## 3. ברמת האחסון (VPS)

### שלב אפס: לבדוק מה כבר רץ על המכונה

ל־VPS יש כבר פרויקט אחר. לפני כל התקנה מריצים ורושמים את הפלט:

```bash
ss -tlnp                         # אילו תהליכים מקשיבים ובאילו פורטים (80, 443, 4000)
docker ps 2>/dev/null            # האם יש קונטיינרים
systemctl list-units --type=service --state=running
node -v; which node              # איזו גרסת Node הפרויקט האחר משתמש
ufw status                       # האם חומת אש פעילה
df -h /; free -h; nproc          # מקום, זיכרון, ליבות
```

החלטות לפי התוצאה:

| ממצא | מה עושים |
|---|---|
| פורט 80 או 443 תפוס (nginx, apache, traefik, קונטיינר) | `setup.sh` ייעצר בכוונה. מוסיפים את האתר לשרת הקיים במקום להתקין Caddy (דוגמה בסעיף 6) |
| פורט 4000 תפוס | משנים `PORT` בקובץ ההגדרות וגם את הפורט ב־`Caddyfile.template` |
| Caddy כבר מותקן ומשרת אתרים אחרים | `setup.sh` לא ידרוס את ה־Caddyfile שלו. הוא מוסיף שורת `import` אחת |
| חומת אש `ufw` פעילה | הסקריפט רק פותח 80 ו־443 |
| חומת אש `ufw` כבויה | הסקריפט **לא** מפעיל אותה. הפעלה חותכת כל פורט שהפרויקט האחר משתמש בו |
| פחות מ־2GB זיכרון פנוי | לבדוק לפני שמתחילים. השרת צורך בערך 100MB כשהוא רגוע וכמה מאות MB בסריקה |

### מה `setup.sh` עושה

1. עוצר אם תוכנה אחרת מחזיקה את פורטים 80/443.
2. מתקין חבילות בסיס, ו־Node 24 **בתיקייה פרטית** `/opt/node24` (עם בדיקת checksum). ה־Node של המערכת לא נוגע, כך שהפרויקט האחר לא מושפע.
3. מתקין Caddy מהמאגר הרשמי, אם הוא לא קיים.
4. יוצר משתמש מערכת `tradesense` בלי כניסה, ותיקיות `/var/lib/tradesense` (המסד) ו־`/var/backups/tradesense` (גיבויים).
5. יוצר את `/etc/tradesense/tradesense.env` מהתבנית (הרשאות 600) אם אינו קיים.
6. כותב את הגדרות האתר ל־`/etc/caddy/tradesense.caddy` ומוסיף ל־Caddyfile שורת `import`. מאמת עם `caddy validate`.
7. רושם את שירות `tradesense`, ומתזמן גיבוי יומי ב־03:17 (cron).
8. מריץ `npm ci` ובונה את האתר.
9. מפעיל את השירות? **לא.** הוא רק מסומן להפעלה אוטומטית, כדי שלא ייווצר מסד ריק לפני שהמסד האמיתי הועתק.

### פריסה על הדיסק

| נתיב | תוכן |
|---|---|
| `/opt/tradesense` | הקוד (clone מ־GitHub) |
| `/opt/node24` | Node 24 פרטי |
| `/etc/tradesense/tradesense.env` | מפתחות והגדרות (סודי, 600) |
| `/var/lib/tradesense/autopilot.sqlite` | המסד החי |
| `/var/backups/tradesense` | גיבויים יומיים, 14 ימים |
| `/etc/caddy/tradesense.caddy` | הגדרת האתר ב־Caddy |
| `/etc/systemd/system/tradesense.service` | השירות |

### הגדרות סביבה

נתוני הסודות מועתקים בידי המשתמש מלשונית Environment בשירות ה־Backend ב־Render, ישירות לקובץ בשרת. אסור להדביק אותם בצ'אט, גם לא כדי לקבל עזרה.

חובה: `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `PUSH_CONTACT`. כל משתני `AUTOPILOT_*` שהיו ב־Render צריכים לעבור גם הם. המשתנים `NODE_ENV`, `PORT`, `APP_DOMAIN`, `CLIENT_ORIGIN`, `AUTOPILOT_DB_PATH` ו־`PORTFOLIO_STORE_FILE_PATH` מוגדרים בתבנית.

### העברת הנתונים

המסד מחזיק את העסקאות, ההגדרות, הלמידה, מפתח ה־VAPID של ההתראות ואת ה־hash של קוד הכניסה. בלי העברה השרת מתחיל ריק, ותבחר קוד חדש ותאבד את ההיסטוריה.

1. ב־Render (Shell או SSH של השירות) מפיקים עותק עקבי וקומפקטי של המסד, גם כשהשרת חי:
   ```bash
   cd /opt/render/project/src/server
   node scripts/backupDb.js /var/data/export.sqlite --compact
   ```
   הפקודה בודקת את העותק עם `integrity_check` לפני שהיא מסיימת. אין להעתיק את קובץ המסד החי ישירות (יחד עם `-wal` ו־`-shm`), כי הוא עלול להיות לא עקבי.
2. מעבירים את העותק ל־VPS. הדרך הנקייה היא `scp` מה־VPS אל Render, דרך SSH של Render (מפתח ציבורי של ה־VPS מתווסף ב־Account Settings ב־Render):
   ```bash
   scp srv-XXXX@ssh.<region>.render.com:/var/data/export.sqlite /var/lib/tradesense/autopilot.sqlite
   chown tradesense:tradesense /var/lib/tradesense/autopilot.sqlite
   ```
3. **לא להעלות את הקובץ לשירותי שיתוף חיצוניים.** הוא מכיל את המפתח הפרטי של ההתראות ואת ה־hash של קוד הכניסה.
4. לוודא שבתיקייה אין קבצי `autopilot.sqlite-wal` או `-shm` ישנים, ושהבעלות על הקובץ היא של `tradesense`.

### סדר החיתוך

הסדר מקטין התראות כפולות ואובדן נתונים:

1. DNS מוכן והאתר נבנה. התעודה תונפק כשהשירות והדומיין זמינים.
2. מפיקים את הייצוא ב־Render ומעתיקים אותו, כמתואר לעיל, ממש לפני החיתוך.
3. `systemctl start tradesense`, ובודקים בלוג (`journalctl -u tradesense -f`) את השורות `SQLite path: /var/lib/tradesense/autopilot.sqlite` ו־`Autopilot scheduler started`.
4. **מיד אחר כך משהים (Suspend) את ה־Web Service ב־Render.** שני שרתים פעילים במקביל שולחים כל התראה פעמיים.
5. הנתונים שנוצרו ב־Render בין הייצוא להשהיה נשארים שם. זה בדרך כלל כמה דקות.

### אחרי המעבר

- לנסות להיכנס בכתובת החדשה עם הקוד הקיים. אם הקוד אבד, `AUTOPILOT_CODE_RESET` בקובץ ההגדרות ואז הפעלה מחדש.
- בטלפון: למחוק את האייקון והסימנייה הישנים, לפתוח את הכתובת החדשה, להוסיף למסך הבית ולחבר התראות. אם הבדיקה לא מגיעה, מבטלים את הרשאת ההתראות לאתר בהגדרות הדפדפן ומחברים שוב.
- משאירים את ה־Web Service ב־Render מושהה כמה ימים כנתיב חזרה. אחר כך מוחקים את ה־Web Service **ואת הדיסק** (אחרי מחיקת הדיסק אי אפשר לשחזר). מחיקת הדיסק וה־Web Service היא מה שמפסיק את התשלום.

### גיבוי

גיבוי עקבי אוטומטי רץ כל לילה ויושב על ה־VPS עצמו. זה לא מגן מפני תקלה של המכונה. מומלץ אחד מאלה:

- להפעיל Auto Backup של Contabo (מופיע בתפריט הצד שלו, יש לבדוק מחיר).
- להעתיק את קובץ הגיבוי מדי פעם למחשב.
- להעלות אותו לבאקט R2 **חדש** ב־Cloudflare, עם API token מוגבל לבאקט הזה. אין להשתמש בפרטי הגישה של הפרויקט האחר.

### אבטחה ותפעול

- להתחבר ל־SSH עם מפתח בלבד, ולכבות כניסה עם סיסמה אם עדיין פתוחה.
- קוד הכניסה לאתר הוא קוד פשוט להפרדת פרופילים, לא אבטחת חשבון. כל מי שמכיר את הכתובת יכול ליצור פרופיל משלו, וזה אותו מצב כמו ב־Render היום.
- ניטור: `https://trade.flowsbiz.com/api/health` מחזיר `{"ok":true}`. אפשר לחבר אותו לבדיקה חינמית בשירות כמו UptimeRobot. השירות מתאושש לבד (`Restart=always`).
- עדכון גרסה: `bash /opt/tradesense/deploy/vps/update.sh`.
- הבאנר האדום באתר ("אחסון השרת זמני") מופיע אם המסד נפתח בנתיב שגוי ונוצר מסד זמני. אם רואים אותו, בודקים את `AUTOPILOT_DB_PATH` והרשאות `/var/lib/tradesense`.

## 4. בדיקות קבלה

כל אלה צריכים לעבור לפני מחיקת Render:

1. `https://trade.flowsbiz.com` נטען ב־HTTPS בלי אזהרה.
2. `https://trade.flowsbiz.com/api/health` מחזיר `{"ok":true}`.
3. כניסה עם הקוד מצליחה, ורואים את העסקאות וההגדרות הקודמות (אם הנתונים הועברו).
4. אין באנר אדום באתר.
5. בלוג: `Autopilot scheduler started`, וללא `EPHEMERAL STORAGE` או `disk is full`.
6. התראת בדיקה מגיעה לטלפון.
7. ביום מסחר: הסריקה האחרונה מתעדכנת (`סריקה אחרונה` באתר).
8. `ls /var/backups/tradesense` מראה גיבוי לילי אחרי הלילה הראשון.

## 5. חזרה אחורה

- בלי למחוק את Render: לבטל Suspend ב־Web Service, ולהחזיר את ה־DNS או להשתמש בכתובת הישנה. מכיוון שהנתונים מתחילים להתפצל, ההחלטה צריכה להיות מוקדמת.
- אחרי מחיקת הדיסק ב־Render אין חזרה, ולכן לא מוחקים לפני כמה ימים תקינים וגיבוי אחד מחוץ למכונה.

## 6. אם ה־VPS כבר מריץ שרת ווב אחר

מריצים רק את החלקים הנחוצים ולא את `setup.sh`: מתקינים Node 24 בנפרד, בונים את האתר (`VITE_API_BASE_URL=https://trade.flowsbiz.com npm run build`), מפעילים את השירות, ומוסיפים אתר לשרת הקיים. דוגמה ל־nginx:

```nginx
server {
    server_name trade.flowsbiz.com;
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location / {
        root /opt/tradesense/client/dist;
        try_files $uri /index.html;
    }
}
```

ואז `certbot --nginx -d trade.flowsbiz.com`.

## 7. הנחיה מוכנה להדבקה בצ'אט שיבצע את המעבר

> אני מעביר פרויקט בשם TradeSense (Node 24, Express, React, SQLite) מ־Render ל־VPS של Contabo עם Ubuntu 24.04. על אותו VPS רץ כבר פרויקט אחר שאסור לפגוע בו. הדומיין `flowsbiz.com` נמצא ב־Cloudflare ומשמש גם הוא פרויקט אחר (Email Routing, R2). אתה מקבל את המסמכים `docs/VPS_MIGRATION.md` ו־`docs/VPS_MIGRATION_HANDOFF.md` ואת הקבצים שב־`deploy/vps/`.
>
> כללים: (1) לפעול צעד אחר צעד ולבקש ממני להדביק את הפלט של כל פקודה לפני שממשיכים. (2) להתחיל בבדיקות של "שלב אפס" ולא להריץ `setup.sh` לפני שהן נבדקו. (3) לא לשנות nameservers ולא לגעת ברשומות DNS קיימות, רק להוסיף רשומה `A` אחת. (4) לא להפעיל חומת אש (`ufw`) אם היא כבויה, ולא לעצור או לשנות שירותים של הפרויקט האחר. (5) לא לבקש ממני מפתחות או סיסמאות בצ'אט. אני מדביק אותם בעצמי בקובץ בשרת. (6) `setup.sh` לא נבדק על מכונה אמיתית, אז לעצור ולהסביר בכל שגיאה ולא לנחש. (7) לא להעלות את קובץ ה־SQLite לשירותי שיתוף חיצוניים. (8) לא למחוק דבר ב־Render לפני שעברו כל בדיקות הקבלה בסעיף 4.

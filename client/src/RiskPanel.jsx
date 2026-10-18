import { useEffect, useRef, useState } from "react";

// Risk management tab. Every value here is saved on the server and enforced there (entries, loss limit,
// take-profit tiers, end of day). Nothing on this page is decoration: a field that is not connected says so.

const str = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : Number(t);
};
const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toLocaleString("he-IL", { maximumFractionDigits: digits }) : "—");

function toForm(profile) {
  return {
    lossPct: str(profile.dailyLoss.pct),
    lossUsd: str(profile.dailyLoss.amountUsd),
    lossAction: profile.dailyLoss.action,
    limitConcurrent: profile.maxConcurrent != null,
    maxConcurrent: str(profile.maxConcurrent),
    stopLossPct: str(profile.stopLossPct),
    tiers: profile.takeProfit.tiers.map((t) => ({ triggerPct: str(t.triggerPct), sellPct: str(t.sellPct) })),
    stopAfter: profile.takeProfit.stopAfter,
    manualStopPrice: str(profile.takeProfit.manualStopPrice),
    endOfDay: profile.endOfDay.mode,
    autoManage: profile.autoManage,
  };
}

function toPayload(f) {
  return {
    dailyLoss: { pct: num(f.lossPct), amountUsd: num(f.lossUsd), action: f.lossAction },
    maxConcurrent: f.limitConcurrent ? num(f.maxConcurrent) : null,
    stopLossPct: num(f.stopLossPct),
    takeProfit: {
      tiers: f.tiers.map((t) => ({ triggerPct: num(t.triggerPct), sellPct: num(t.sellPct) })),
      stopAfter: f.stopAfter,
      manualStopPrice: f.stopAfter === "manual" ? num(f.manualStopPrice) : null,
    },
    endOfDay: { mode: f.endOfDay },
    autoManage: f.autoManage,
  };
}

const COMMAND_LABEL = { close: "סגירה", partial_close: "מכירה חלקית", modify_stop: "הזזת סטופ" };
const STATUS_LABEL = { pending: "ממתינה ל־EA", claimed: "ה־EA מטפל", closed: "אושרה ב־MT4", rejected: "נדחתה", expired: "פג תוקף", unknown: "מצב לא ידוע, בדוק ב־MT4" };
const TIER_LABEL = { pending: "ממתינה לאישור MT4", done: "בוצעה", skipped: "דולגה", failed: "נכשלה" };

export default function RiskPanel({ executionApi, executionState, mt4Positions, busy, onNotice, onError }) {
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);

  async function load() {
    try {
      const result = await executionApi("/risk-profile");
      setServer(result);
      if (!dirty.current) setForm(toForm(result.profile));
    } catch (e) {
      onError?.(e.message);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const set = (patch) => {
    dirty.current = true;
    setForm((f) => ({ ...f, ...patch }));
  };
  const setTier = (i, patch) => {
    dirty.current = true;
    setForm((f) => ({ ...f, tiers: f.tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  };

  async function save() {
    setSaving(true);
    try {
      const result = await executionApi("/risk-profile", { method: "PUT", body: JSON.stringify(toPayload(form)) });
      dirty.current = false;
      setForm(toForm(result.profile));
      await load();
      onNotice?.("ההגדרות נשמרו בשרת ונטענו מחדש");
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!form || !server) return <div className="panel muted">טוען את הגדרות הסיכון מהשרת…</div>;
  const day = server.day || {};
  const manager = server.manager || {};
  const status = manager.status || null;
  const mt4 = executionState?.agentConnected;
  const fresh = Boolean(mt4Positions?.fresh);
  const hasLossValue = form.lossPct.trim() !== "" || form.lossUsd.trim() !== "";
  const tierWarn = (t) => num(t.triggerPct) != null && num(t.sellPct) == null;

  return (
    <div className="risk-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">חשבון דמו בלבד</span>
          <h1>ניהול סיכונים ויציאות</h1>
          <p>ההגדרות נשמרות בשרת ונאכפות שם, לא רק בדשבורד. פעולה מסומנת כמוצלחת רק אחרי שאושרה ב־MT4.</p>
        </div>
        <button className="primary" disabled={busy || saving || !dirty.current || !hasLossValue} onClick={save}>
          {saving ? "שומר…" : "שמור הגדרות"}
        </button>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>מצב מערכת וחיבור MT4</h2>
          <span className={mt4 && fresh ? "badge live-badge" : "badge amber"}>{mt4 && fresh ? "מחובר ומדווח" : "אין דיווח עדכני"}</span>
        </div>
        <div className="risk-status-grid">
          <div><span>פוזיציות מנוהלות</span><b>{manager.positions?.length ?? 0}</b></div>
          <div><span>כניסות חדשות</span><b>{!fresh ? "חסומות: אין נתוני MT4" : day.breached ? "חסומות: הגעת למגבלת ההפסד" : !day.hasBase ? "חסומות עד הפעלת מסחר" : "מותרות לפי המגבלות"}</b></div>
        </div>
        <p className="muted">
          ארבע פעולות נפרדות: עצירת סריקה, עצירת כניסות חדשות (מגבלת הפסד), עצירת מסחר עצמאי (מרכז שליטה) וסגירת פוזיציות (כאן או בכפתור הסגירה ליד הפוזיציה). מכירה בחסר (שורט) מושבתת עד לאימות תמיכה.
        </p>
        {(status?.warnings || []).map((w) => <div className="banner warning" key={w}>{w}</div>)}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>א. מגבלת הפסד יומית</h2></div>
        <div className="risk-fields">
          <label>אחוז הפסד מרבי<input dir="ltr" inputMode="decimal" value={form.lossPct} onChange={(e) => set({ lossPct: e.target.value })} placeholder="ללא" /></label>
          <label>סכום מרבי בדולרים<input dir="ltr" inputMode="decimal" value={form.lossUsd} onChange={(e) => set({ lossUsd: e.target.value })} placeholder="ללא" /></label>
        </div>
        {!hasLossValue && <div className="banner error">חובה להגדיר אחוז או סכום (ברירת מחדל: 7%).</div>}
        <p className="muted">ההפסד כולל ממומש ולא ממומש: שווי החשבון בהפעלה הראשונה של יום המסחר האמריקאי פחות השווי הנוכחי. כשמוגדרים שניהם, החמור מביניהם קובע. עצירה והפעלה מחדש לא מאפסות את הבסיס; האיפוס ביום המסחר האמריקאי הבא.</p>
        <div className="risk-choice">
          <strong>בהגעה למגבלה:</strong>
          <label><input type="radio" name="lossAction" checked={form.lossAction === "close_all"} onChange={() => set({ lossAction: "close_all" })} /> לסגור את כל הפוזיציות ש־TradeSense מנהלת (ברירת מחדל)</label>
          <label><input type="radio" name="lossAction" checked={form.lossAction === "stop_new"} onChange={() => set({ lossAction: "stop_new" })} /> לעצור כניסות חדשות ולהמשיך לנהל פוזיציות פתוחות</label>
        </div>
        <div className="risk-live">
          <div><span>בסיס היום</span><b dir="ltr">{day.hasBase ? fmt(day.baseEquity) : "טרם נקבע (נקבע בהפעלת המסחר)"}</b></div>
          <div><span>שווי נוכחי</span><b dir="ltr">{fmt(day.equity)}</b></div>
          <div><span>הפסד נוכחי</span><b dir="ltr" className={day.loss > 0 ? "pl-down" : ""}>{fmt(day.loss)}</b></div>
          <div><span>מגבלה (בשרת)</span><b dir="ltr">{fmt(day.limit)}</b></div>
        </div>
        {day.breached && <div className="banner error">מגבלת ההפסד הופעלה ב־{new Date(day.breachedAt).toLocaleTimeString("he-IL")}. הכניסות חסומות עד יום המסחר הבא. {day.breach?.action === "close_all" ? "הסגירה האוטומטית תלויה בכך שהניהול האוטומטי פועל." : ""}</div>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ב. עסקאות במקביל</h2></div>
        <div className="risk-fields">
          <label className="inline"><input type="checkbox" checked={!form.limitConcurrent} onChange={(e) => set({ limitConcurrent: !e.target.checked })} /> ללא מגבלה (ברירת מחדל)</label>
          <label>מספר מרבי<input dir="ltr" inputMode="numeric" disabled={!form.limitConcurrent} value={form.maxConcurrent} onChange={(e) => set({ maxConcurrent: e.target.value })} /></label>
        </div>
        <p className="muted">נספרות רק פוזיציות ש־TradeSense מנהלת, וגם פקודות שעדיין ממתינות לאישור. כשהמגבלה מלאה מדלגים על האיתות וממשיכים לסרוק. הורדת המגבלה מתחת למספר הקיים לא סוגרת פוזיציות, רק חוסמת כניסות.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ג. Stop Loss לעסקה</h2></div>
        <div className="risk-fields">
          <label>אחוז סטופ קבוע מהכניסה<input dir="ltr" inputMode="decimal" value={form.stopLossPct} onChange={(e) => set({ stopLossPct: e.target.value })} placeholder="לא הוגדר" /></label>
        </div>
        <p className="muted">לא הוגדר ערך ברירת מחדל. כשהשדה ריק, נשאר הסטופ של האיתות. בלונג הסטופ מתחת לכניסה. סטופ הוא פקודת הגנה ולא הבטחה לביצוע במחיר המדויק: החלקה ופערי מחיר אפשריים. הפקודה נשלחת ל־MT4 עם סטופ, וכל פוזיציה מנוהלת בלי סטופ מסומנת באזהרה.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ד. מימוש רווחים</h2></div>
        <p className="muted">אחוזי העלייה מחושבים ממחיר הכניסה המקורי. אחוזי המכירה הם מהפוזיציה המקורית. אין להם ערך ברירת מחדל: מדרגה בלי אחוז מכירה לא תפעל.</p>
        <div className="tier-table">
          {form.tiers.map((t, i) => (
            <div className="tier-row" key={i}>
              <b>מדרגה {i + 1}</b>
              <label>עלייה ב־%<input dir="ltr" inputMode="decimal" value={t.triggerPct} onChange={(e) => setTier(i, { triggerPct: e.target.value })} placeholder={i === 2 ? "כבויה" : ""} /></label>
              <label>למכור % מהמקור<input dir="ltr" inputMode="decimal" value={t.sellPct} onChange={(e) => setTier(i, { sellPct: e.target.value })} placeholder="לא הוגדר" /></label>
              {tierWarn(t) && <small className="warn-text">לא פעילה עד שתוגדר כמות מכירה</small>}
            </div>
          ))}
        </div>
        <div className="risk-choice">
          <strong>סטופ אחרי מימוש רווח:</strong>
          <label><input type="radio" name="stopAfter" checked={form.stopAfter === "keep"} onChange={() => set({ stopAfter: "keep" })} /> להשאיר את הסטופ המקורי</label>
          <label><input type="radio" name="stopAfter" checked={form.stopAfter === "breakeven"} onChange={() => set({ stopAfter: "breakeven" })} /> להעלות את הסטופ למחיר הכניסה</label>
          <label><input type="radio" name="stopAfter" checked={form.stopAfter === "manual"} onChange={() => set({ stopAfter: "manual" })} /> מחיר סטופ ידני
            <input dir="ltr" inputMode="decimal" disabled={form.stopAfter !== "manual"} value={form.manualStopPrice} onChange={(e) => set({ manualStopPrice: e.target.value })} placeholder="מחיר" /></label>
        </div>
        <p className="muted">כמויות קטנות מהמינימום של הברוקר (ב־Colmex 10 מניות) לא מבוצעות: המדרגה מדולגת והסיבה מוצגת. קפיצת מחיר מעל כמה מדרגות מבצעת מכירה אחת משולבת.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ה. סוף יום המסחר</h2></div>
        <div className="risk-choice">
          <label><input type="radio" name="eod" checked={form.endOfDay === "close"} onChange={() => set({ endOfDay: "close" })} /> לסגור את הפוזיציות ש־TradeSense מנהלת דקה לפני סגירת המסחר בארה"ב (ברירת מחדל)</label>
          <label><input type="radio" name="eod" checked={form.endOfDay === "keep"} onChange={() => set({ endOfDay: "keep" })} /> להשאיר אותן פתוחות</label>
        </div>
        <p className="muted">התזמון לפי לוח המסחר האמריקאי, כולל סגירה מוקדמת. אם הלוח לא זמין, לא תתבצע סגירה אוטומטית וזה יוצג כאן. כישלון בסגירה מוצג ליד המניה ולא יחזור על עצמו, גם לא למחרת.</p>
        {status?.eod && (status.eod.available === false ? <div className="banner warning">{status.eod.reason}</div> : status.eod.closeAt ? <small>סגירת המסחר היום: {new Date(status.eod.closeAt).toLocaleTimeString("he-IL")}</small> : null)}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>ו. ניהול אוטומטי של פוזיציות</h2>
          <span className={form.autoManage ? "badge live-badge" : "badge amber"}>{form.autoManage ? "פעיל" : "כבוי"}</span>
        </div>
        <label className="inline"><input type="checkbox" checked={form.autoManage} onChange={(e) => set({ autoManage: e.target.checked })} /> לאפשר לשרת לסגור, למכור חלקית ולהזיז סטופ בפוזיציות ש־TradeSense מנהלת (חשבון דמו, לפי ההגדרות למעלה)</label>
        <p className="muted">דלוק כברירת מחדל, כך שמגבלת ההפסד היומי וסגירת סוף היום פועלות גם בלי שינוי ערכים; מדרגות הרווח לא יפעלו עד שתזין אחוזי מכירה. הפעולות מגיעות ל־MT4 רק כשדגל התור בשרת וה־EA במצב ביצוע דלוקים. כשהוא כבוי, המגבלות עדיין חוסמות כניסות, אבל שום פוזיציה לא נסגרת ולא משתנה אוטומטית. הפעולות דורשות שה־EA יהיה במצב ביצוע. עסקאות שנפתחו ידנית ב־MT4 לעולם לא נסגרות אוטומטית.</p>
        {(manager.positions || []).length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>מניה</th><th>כמות מקורית / נמכרה</th><th>מדרגות</th><th>פעולה אחרונה</th><th>הערות</th></tr></thead>
              <tbody>
                {manager.positions.map((p) => (
                  <tr key={p.ticket}>
                    <td dir="ltr">{p.symbol}</td>
                    <td>{fmt(p.originalLots, 4)} / {fmt(p.soldLots, 4)}</td>
                    <td>{Object.entries(p.tiers).map(([k, t]) => <div key={k}>מדרגה {k}: {TIER_LABEL[t.status] || t.status}{t.note ? ` (${t.note})` : ""}</div>)}{!Object.keys(p.tiers).length && "—"}</td>
                    <td>{p.lastCommand ? `${COMMAND_LABEL[p.lastCommand.type] || p.lastCommand.type}: ${STATUS_LABEL[p.lastCommand.status] || p.lastCommand.status}${p.lastCommand.error ? ` (${p.lastCommand.error})` : ""}` : "—"}</td>
                    <td>{[p.halted, p.stopNote, p.hasStop ? null : "אין סטופ ב־MT4"].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין כרגע פוזיציות ש־TradeSense מנהלת.</p>}
      </section>

    </div>
  );
}

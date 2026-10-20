import { useEffect, useMemo, useRef, useState } from "react";

// Entry tab: how signals become a score, and how the score becomes a share count.
// Everything saved here is enforced on the server (entryDecision). The simulator below uses the same formula.

const str = (v) => (v === null || v === undefined ? "" : String(v));
const n = (v) => (String(v ?? "").trim() === "" ? NaN : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString("he-IL", { maximumFractionDigits: d }) : "—");

function toForm(p) {
  return {
    windowMin: str(p.windowMin), minScore: str(p.minScore), immediateScore: str(p.immediateScore),
    fp: p.familyPoints.map(str), qualityMax: str(p.qualityMax),
    perTradeMinPct: str(p.perTradeMinPct), perTradeMaxPct: str(p.perTradeMaxPct),
    totalExposurePct: str(p.totalExposurePct), maxRiskPct: str(p.maxRiskPct), minShares: str(p.minShares),
  };
}
const toPayload = (f) => ({
  windowMin: f.windowMin, minScore: f.minScore, immediateScore: f.immediateScore, familyPoints: f.fp, qualityMax: f.qualityMax,
  perTradeMinPct: f.perTradeMinPct, perTradeMaxPct: f.perTradeMaxPct, totalExposurePct: f.totalExposurePct, maxRiskPct: f.maxRiskPct, minShares: f.minShares,
});

// Same formula as the server (entryDecision.size).
function sizeOf({ score, price, stop, equity, exposure, p }) {
  const t = clamp((score - p.minScore) / Math.max(1, 100 - p.minScore), 0, 1);
  const pct = p.perTradeMinPct + (p.perTradeMaxPct - p.perTradeMinPct) * t;
  const byBudget = Math.floor((equity * pct) / 100 / price);
  const dist = price - stop;
  const byRisk = dist > 0 ? Math.floor((equity * p.maxRiskPct) / 100 / dist) : 0;
  const byRoom = Math.floor((equity * p.totalExposurePct) / 100 / price - exposure / price);
  const shares = Math.max(0, Math.min(byBudget, byRisk, byRoom));
  const limit = shares === byRoom && byRoom < Math.min(byBudget, byRisk) ? "חשיפה כוללת" : shares === byRisk && byRisk < byBudget ? "סיכון לעסקה" : "תקציב";
  return { pct, byBudget, byRisk, byRoom, shares, limit };
}

const OUTCOME = { entered: "נכנסנו", skipped: "דולגה", ignored: "התעלמות" };
const STATE = { open: "אוספת איתותים", entered: "נכנסנו", skipped: "דולגה" };

export default function EntryPanel({ executionApi, executionState, onNotice, onError }) {
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mt4, setMt4] = useState(null);
  const [sim, setSim] = useState({ score: "70", price: "50", stopPct: "2" });
  const dirty = useRef(false);

  async function load() {
    try {
      const r = await executionApi("/entry");
      setServer(r);
      if (!dirty.current) setForm(toForm(r.profile));
      executionApi("/positions").then(setMt4).catch(() => {});
    } catch (e) {
      onError?.(e.message);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const set = (patch) => { dirty.current = true; setForm((f) => ({ ...f, ...patch })); };
  const setFp = (i, v) => { dirty.current = true; setForm((f) => ({ ...f, fp: f.fp.map((x, k) => (k === i ? v : x)) })); };

  async function save() {
    setSaving(true);
    try {
      const r = await executionApi("/entry", { method: "PUT", body: JSON.stringify(toPayload(form)) });
      dirty.current = false;
      setServer(r);
      setForm(toForm(r.profile));
      onNotice?.("כללי הכניסה נשמרו בשרת");
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }
  function reset() { dirty.current = true; setForm(toForm(server.defaults)); }

  const p = useMemo(() => form && ({
    minScore: n(form.minScore), perTradeMinPct: n(form.perTradeMinPct), perTradeMaxPct: n(form.perTradeMaxPct),
    totalExposurePct: n(form.totalExposurePct), maxRiskPct: n(form.maxRiskPct), minShares: n(form.minShares),
  }), [form]);

  if (!form || !server) return <div className="panel muted">טוען את כללי הכניסה מהשרת…</div>;
  // Only symbols still waiting for a decision; decided ones live in the decision log.
  const waiting = server.boxes.filter((b) => b.state === "open");

  const equity = mt4?.fresh && Number.isFinite(mt4.equity) ? mt4.equity : null;
  const simEquity = equity ?? 100000;
  const price = n(sim.price), score = n(sim.score), stop = price * (1 - n(sim.stopPct) / 100);
  const exposure = mt4?.fresh ? (mt4.positions || []).reduce((s, x) => s + Math.abs(x.lots) * (x.currentPrice ?? x.openPrice), 0) : 0;
  const ok = [price, score, stop].every(Number.isFinite) && price > 0 && Object.values(p).every(Number.isFinite);
  const r = ok ? sizeOf({ score, price, stop, equity: simEquity, exposure, p }) : null;
  const enters = ok && score >= p.minScore;
  const field = (label, key, hint) => (
    <label>{label}<input dir="ltr" inputMode="decimal" value={form[key]} onChange={(e) => set({ [key]: e.target.value })} />{hint && <small>{hint}</small>}</label>
  );

  return (
    <div className="entry-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">חשבון דמו בלבד · לונג בלבד</span>
          <h1>כניסה לעסקאות</h1>
          <p>איתותים נאספים בקופסה לכל מניה, מקבלים ציון, ורק אם הציון מספיק נפתחת פקודה אחת בכמות שנגזרת מהיתרה האמיתית ב־MT4. הערכים נשמרים ונאכפים בשרת.</p>
        </div>
        <div className="entry-actions">
          <button className="secondary" onClick={reset} disabled={saving}>איפוס לברירת מחדל</button>
          <button className="primary" disabled={saving || !dirty.current} onClick={save}>{saving ? "שומר…" : "שמור"}</button>
        </div>
      </div>

      <section className="panel">
        <div className="section-heading"><h2>א. ציון ההזדמנות</h2></div>
        <p className="muted">הציון נקבע לפי כמה משפחות אסטרטגיה שונות מסכימות על אותה מניה (אסטרטגיות דומות, כמו שתי גרסאות של פריצת טווח פתיחה, נספרות כאחת), ובונוס קטן לאיכות: נפח יחסי, נזילות ומרחק הסטופ ביחס לתנודתיות.</p>
        <div className="risk-fields">
          {["משפחה אחת", "שתי משפחות", "שלוש משפחות", "ארבע ומעלה"].map((l, i) => (
            <label key={l}>{l}<input dir="ltr" inputMode="decimal" value={form.fp[i]} onChange={(e) => setFp(i, e.target.value)} /></label>
          ))}
          {field("תקרת בונוס איכות (± נקודות)", "qualityMax")}
        </div>
        <div className="risk-fields">
          {field("ציון מינימום לכניסה", "minScore", "מתחתיו המניה מדולגת בסוף החלון")}
          {field("ציון לכניסה מיידית", "immediateScore", "מעליו לא מחכים לסוף החלון")}
          {field("חלון איסוף (דקות, עד 8)", "windowMin", "איתות חי 10 דקות, ההחלטה לפני שהוא פג")}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ב. תקציב וכמות</h2></div>
        <p className="muted">התקציב לעסקה הוא אחוז מהשווי הנוכחי של חשבון הדמו ב־MT4, והוא גדל עם הציון. הכמות מעוגלת כלפי מטה ומוגבלת גם לפי הסיכון עד הסטופ והחשיפה הכוללת. מתחת למינימום של הברוקר מדלגים.</p>
        <div className="risk-fields">
          {field("% מההון בציון הנמוך", "perTradeMinPct")}
          {field("% מההון בציון 100", "perTradeMaxPct")}
          {field("חשיפה כוללת מרבית (% מההון)", "totalExposurePct")}
          {field("הפסד מרבי עד הסטופ (% מההון)", "maxRiskPct")}
          {field("כמות מינימלית (מניות)", "minShares")}
        </div>
      </section>

      <section className="panel entry-sim">
        <div className="section-heading"><h2>סימולטור: מה תהיה הכמות?</h2><span className="badge">{equity != null ? `הון MT4: ${fmt(equity)}` : "הון לדוגמה: 100,000"}</span></div>
        <div className="risk-fields">
          <label>ציון<input dir="ltr" inputMode="decimal" value={sim.score} onChange={(e) => setSim({ ...sim, score: e.target.value })} /></label>
          <label>מחיר מניה ($)<input dir="ltr" inputMode="decimal" value={sim.price} onChange={(e) => setSim({ ...sim, price: e.target.value })} /></label>
          <label>מרחק הסטופ (%)<input dir="ltr" inputMode="decimal" value={sim.stopPct} onChange={(e) => setSim({ ...sim, stopPct: e.target.value })} /></label>
        </div>
        {r ? (
          <div className="sim-result">
            <div><span>החלטה</span><b>{enters ? "נכנסים" : "מדלגים (ציון נמוך)"}</b></div>
            <div><span>% מההון</span><b>{fmt(r.pct, 1)}%</b></div>
            <div><span>לפי תקציב</span><b>{fmt(r.byBudget)}</b></div>
            <div><span>לפי סיכון</span><b>{fmt(r.byRisk)}</b></div>
            <div><span>לפי חשיפה</span><b>{fmt(r.byRoom)}</b></div>
            <div className={enters && r.shares >= p.minShares ? "sim-final" : "sim-final bad"}><span>כמות סופית</span><b>{enters ? (r.shares >= p.minShares ? `${fmt(r.shares)} מניות · $${fmt(r.shares * price)}` : `${fmt(r.shares)}: מתחת למינימום, מדלגים`) : "—"}</b><small>מוגבל לפי: {r.limit}</small></div>
          </div>
        ) : <p className="muted">יש להזין מספרים תקינים.</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>ממתינות להחלטה</h2><span className="badge">{waiting.length}</span></div>
        {waiting.length ? (
          <table><thead><tr><th>מניה</th><th>נפתחה</th><th>אסטרטגיות</th><th>משפחות</th><th>ציון</th></tr></thead><tbody>
            {waiting.map((b) => <tr key={b.symbol + b.openedAt}><td dir="ltr">{b.symbol}</td><td>{new Date(b.openedAt).toLocaleTimeString("he-IL")}</td><td dir="ltr">{b.strategies.join(", ")}</td><td>{b.families.length || "—"}</td><td>{b.score ?? "—"}</td></tr>)}
          </tbody></table>
        ) : <p className="muted">אין כרגע מניות שממתינות להחלטה. קופסה נפתחת כשמגיע איתות בזמן שהמסחר האוטומטי פועל, וברגע שהתקבלה החלטה היא עוברת ליומן ההחלטות.</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>יומן החלטות</h2><span className="badge">{server.decisions.length}</span></div>
        {server.decisions.length ? (
          <table><thead><tr><th>תאריך ושעה</th><th>מניה</th><th>החלטה</th><th>ציון</th><th>כמות</th><th>למה</th></tr></thead><tbody>
            {server.decisions.map((d) => <tr key={d.id}><td>{new Date(d.at).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td><td dir="ltr">{d.symbol}</td><td className={d.outcome === "entered" ? "pl-up" : ""}>{OUTCOME[d.outcome] || d.outcome}</td><td>{d.score ?? "—"}</td><td>{d.sizing?.shares ?? "—"}</td><td>{d.reasonText}</td></tr>)}
          </tbody></table>
        ) : <p className="muted">עדיין לא התקבלו החלטות. כל כניסה ודילוג יירשמו כאן עם הסיבה.</p>}
      </section>
    </div>
  );
}

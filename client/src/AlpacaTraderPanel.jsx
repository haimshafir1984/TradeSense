import { useEffect, useRef, useState } from "react";

// "חשבון דמו Alpaca" tab. Fully separate from the Colmex/MT4 side: its own account, its own
// universe (lower price/liquidity floor, no Colmex symbol map), its own risk settings.

const str = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : Number(t);
};
const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toLocaleString("he-IL", { maximumFractionDigits: digits }) : "—");
const money = (v) => (Number.isFinite(v) ? `$${fmt(v)}` : "—");
const time = (v) => (v ? new Date(v).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

const OUTCOME_LABEL = { entered: "נכנסנו", skipped: "דילגנו" };
const REASON_LABEL = {
  score_low: "ציון נמוך מהסף", signals_expired: "האיתותים פגו", size_too_small: "כמות קטנה מדי",
  disabled: "המסחר כבוי", daily_loss_breached: "הפסד יומי חרג", account_unavailable: "אין חיבור לחשבון",
  symbol_busy: "כבר יש פוזיציה/הזמנה", not_configured: "המפתחות לא מוגדרים",
};
const EXIT_REASON_LABEL = { stop: "סטופ", target: "יעד", end_of_day: "סוף יום", daily_loss_breached: "הפסד יומי חרג" };

function toForm(profile) {
  return {
    enabled: profile.enabled,
    perTradeMinPct: str(profile.perTradeMinPct),
    perTradeMaxPct: str(profile.perTradeMaxPct),
    totalExposurePct: str(profile.totalExposurePct),
    maxRiskPct: str(profile.maxRiskPct),
    dailyLossPct: str(profile.dailyLossPct),
    minPrice: str(profile.minPrice),
    minAdv20: str(profile.minAdv20),
    maxAdv20: str(profile.maxAdv20),
    minShares: str(profile.minShares),
    minScore: str(profile.minScore),
    strategies: profile.strategies,
  };
}
function toPayload(f) {
  return {
    enabled: f.enabled,
    perTradeMinPct: num(f.perTradeMinPct),
    perTradeMaxPct: num(f.perTradeMaxPct),
    totalExposurePct: num(f.totalExposurePct),
    maxRiskPct: num(f.maxRiskPct),
    dailyLossPct: num(f.dailyLossPct),
    minPrice: num(f.minPrice),
    minAdv20: num(f.minAdv20),
    maxAdv20: num(f.maxAdv20),
    minShares: num(f.minShares),
    minScore: num(f.minScore),
    strategies: f.strategies,
  };
}

const STRATEGY_LABEL = {
  orb15: "פריצת טווח פתיחה", orb15_retest: "פריצה ובדיקה חוזרת", vwap_reclaim: "חזרה מעל VWAP",
  vwap_pullback: "תיקון ל-VWAP", reversal5: "התאוששות קצרה", pullback2_v1: "תיקון יומיים",
  breakout20_v1: "פריצת שיא 20 יום",
};

export default function AlpacaTraderPanel({ alpacaApi, busy, onNotice, onError }) {
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);

  async function load() {
    try {
      const result = await alpacaApi("/status");
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

  const set = (patch) => { dirty.current = true; setForm((f) => ({ ...f, ...patch })); };
  const toggleStrategy = (key) => {
    dirty.current = true;
    setForm((f) => ({ ...f, strategies: f.strategies.includes(key) ? f.strategies.filter((s) => s !== key) : [...f.strategies, key] }));
  };

  async function save() {
    setSaving(true);
    try {
      const result = await alpacaApi("/settings", { method: "PATCH", body: JSON.stringify(toPayload(form)) });
      dirty.current = false;
      setForm(toForm(result));
      await load();
      onNotice?.("ההגדרות נשמרו");
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!form || !server) return <div className="panel muted">טוען את חשבון ה-Alpaca...</div>;

  const configured = server.configured;
  const account = server.account && !server.account.error ? server.account : null;
  const equity = account ? Number(account.equity) : null;
  const startEquity = server.day?.hasBase ? server.day.baseEquity : null;
  const dayPnl = Number.isFinite(equity) && Number.isFinite(startEquity) ? equity - startEquity : null;
  const positions = server.positions || [];
  const candidates = (server.candidates || []).filter((b) => b.state === "open");
  const decisions = server.decisions || [];
  const exits = server.exits || [];
  const uni = server.universe || {};
  const todayKey = new Date().toDateString();
  const todays = decisions.filter((d) => new Date(d.at).toDateString() === todayKey);
  const entered = todays.filter((d) => d.outcome === "entered");
  const investedNow = positions.reduce((sum, p) => sum + Math.abs(Number(p.market_value) || 0), 0);
  const allocatedToday = entered.reduce((sum, d) => sum + (Number(d.price) || 0) * (Number(d.sizing?.shares) || 0), 0);
  const pctOf = (value) => (Number.isFinite(equity) && equity > 0 ? `${fmt((value / equity) * 100, 1)}%` : "—");
  const exitFor = (d) => exits.filter((x) => x.symbol === d.symbol && new Date(x.at) >= new Date(d.at)).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
  // Skipped checks repeat every 5 minutes for the same stock: fold them into one row per stock.
  const skippedBySymbol = Object.values(
    todays.filter((d) => d.outcome === "skipped").reduce((acc, d) => {
      const row = (acc[d.symbol] ||= { symbol: d.symbol, checks: 0, bestScore: null, lastAt: d.at, reason: d.reason, reasonText: d.reasonText });
      row.checks += 1;
      if (Number.isFinite(Number(d.score))) row.bestScore = Math.max(row.bestScore ?? -Infinity, Number(d.score));
      if (new Date(d.at) >= new Date(row.lastAt)) Object.assign(row, { lastAt: d.at, reason: d.reason, reasonText: d.reasonText });
      return acc;
    }, {}),
  ).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  return (
    <div className="risk-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">חשבון דמו נפרד, לא קשור ל-Colmex/MT4</span>
          <h1>חשבון דמו Alpaca</h1>
          <p>סריקה עצמאית על מניות small/mid-cap תנודתיות, עם חשבון נייר (paper) נפרד ב-Alpaca. שינוי כאן לא משפיע על הצד השני.</p>
        </div>
        <button className="primary" disabled={busy || saving || !dirty.current} onClick={save}>
          {saving ? "שומר..." : "שמור הגדרות"}
        </button>
      </div>

      {!configured && (
        <div className="banner error" role="alert">
          מפתחות ALPACA_TRADER_API_KEY_ID / ALPACA_TRADER_API_SECRET_KEY לא מוגדרים בשרת. הגדר אותם ב-Dokploy כדי שהחשבון יתחבר.
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <h2>מצב חשבון</h2>
          <span className={configured && account ? "badge live-badge" : "badge amber"}>{configured && account ? "מחובר" : "אין חיבור"}</span>
        </div>
        <div className="risk-live">
          <div><span>שווי חשבון נוכחי</span><b dir="ltr">{money(equity)}</b></div>
          <div><span>שווי בתחילת היום</span><b dir="ltr">{money(startEquity)}</b></div>
          <div><span>רווח/הפסד מתחילת היום</span><b dir="ltr" className={dayPnl > 0 ? "pl-up" : dayPnl < 0 ? "pl-down" : ""}>{money(dayPnl)}</b></div>
          <div><span>מזומן פנוי</span><b dir="ltr">{account ? money(Number(account.cash)) : "—"}</b></div>
          <div><span>מושקע כרגע בפוזיציות פתוחות</span><b dir="ltr">{money(investedNow)} ({pctOf(investedNow)} מהתיק)</b></div>
          <div><span>הוקצה היום לעסקאות (סה"כ כניסות)</span><b dir="ltr">{money(allocatedToday)} ({pctOf(allocatedToday)} מהתיק)</b></div>
        </div>
        {server.day?.breached && (
          <div className="banner error">מגבלת ההפסד היומי הופעלה. כניסות חדשות חסומות עד יום המסחר הבא; פוזיציות פתוחות נסגרות אוטומטית.</div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>הפעלה</h2></div>
        <label className="inline">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          מסחר פעיל בחשבון Alpaca (סריקה רצה תמיד; כיבוי כאן עוצר רק כניסות חדשות, לא מעקב אחרי פוזיציות קיימות)
        </label>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>סף ומאגר מניות</h2></div>
        <div className="risk-fields">
          <label>סף מחיר תחתון ($)<input dir="ltr" inputMode="decimal" value={form.minPrice} onChange={(e) => set({ minPrice: e.target.value })} /></label>
          <label>נזילות מינימלית - ADV20 ($)<input dir="ltr" inputMode="decimal" value={form.minAdv20} onChange={(e) => set({ minAdv20: e.target.value })} /></label>
          <label>נזילות מקסימלית - ADV20 ($)<input dir="ltr" inputMode="decimal" value={form.maxAdv20} onChange={(e) => set({ maxAdv20: e.target.value })} /></label>
        </div>
        <p className="muted">מניות NASDAQ/NYSE בלבד, לא OTC. המאגר נבחר לפי התנודתיות היומית הגבוהה ביותר, בטווח הנזילות שנקבע. המאגר הנוכחי: {uni.ready ? `${fmt(uni.size, 0)} מניות (${uni.date})` : "טרם נבנה היום"}.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>סיכון וגודל פוזיציה</h2></div>
        <div className="risk-fields">
          <label>אחוז מינימלי לעסקה<input dir="ltr" inputMode="decimal" value={form.perTradeMinPct} onChange={(e) => set({ perTradeMinPct: e.target.value })} /></label>
          <label>אחוז מקסימלי לעסקה<input dir="ltr" inputMode="decimal" value={form.perTradeMaxPct} onChange={(e) => set({ perTradeMaxPct: e.target.value })} /></label>
          <label>חשיפה כוללת (%)<input dir="ltr" inputMode="decimal" value={form.totalExposurePct} onChange={(e) => set({ totalExposurePct: e.target.value })} /></label>
          <label>סיכון מרבי לעסקה (%)<input dir="ltr" inputMode="decimal" value={form.maxRiskPct} onChange={(e) => set({ maxRiskPct: e.target.value })} /></label>
          <label>הפסד יומי מרבי (%)<input dir="ltr" inputMode="decimal" value={form.dailyLossPct} onChange={(e) => set({ dailyLossPct: e.target.value })} /></label>
          <label>ציון מינימלי לכניסה<input dir="ltr" inputMode="decimal" value={form.minScore} onChange={(e) => set({ minScore: e.target.value })} /></label>
          <label>כמות מינימלית למניה<input dir="ltr" inputMode="numeric" value={form.minShares} onChange={(e) => set({ minShares: e.target.value })} /></label>
        </div>
        <p className="muted">אין מגבלת לוט של Colmex כאן: Alpaca מאפשרת כל כמות, כולל שברי מניה. "כמות מינימלית" הוא סף שבחרת, לא מגבלת ברוקר.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>אסטרטגיות פעילות</h2></div>
        <div className="risk-fields">
          {Object.entries(STRATEGY_LABEL).map(([key, label]) => (
            <label key={key} className="inline">
              <input type="checkbox" checked={form.strategies.includes(key)} onChange={() => toggleStrategy(key)} /> {label}
            </label>
          ))}
        </div>
        <p className="muted">gap_pullback ו-momentum_bull_flag לא זמינות כאן עדיין: הן דורשות בדיקת חדשות שלא חוברה בגרסה הזו.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>מניות שנסרקו היום ועדיין ממתינות</h2></div>
        {candidates.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>מניה</th><th>אסטרטגיות</th><th>נפתח</th></tr></thead>
              <tbody>
                {candidates.map((b) => (
                  <tr key={b.symbol}><td dir="ltr">{b.symbol}</td><td>{[...new Set(b.signals.map((s) => s.strategy))].map((s) => STRATEGY_LABEL[s] || s).join(", ")}</td><td>{time(b.openedAt)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין כרגע מועמדות שממתינות להחלטה.</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>מה נקנה היום</h2></div>
        {entered.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>שעה</th><th>מניה</th><th>אסטרטגיה</th><th>ציון</th><th>כמות</th><th>סכום</th><th>% מהתיק</th><th>תוצאה</th></tr></thead>
              <tbody>
                {entered.map((d) => {
                  const amount = (Number(d.price) || 0) * (Number(d.sizing?.shares) || 0);
                  const x = exitFor(d);
                  return (
                    <tr key={d.id}>
                      <td>{time(d.at)}</td>
                      <td dir="ltr">{d.symbol}</td>
                      <td>{(d.strategies || []).map((n) => STRATEGY_LABEL[n] || n).join(", ") || "—"}</td>
                      <td dir="ltr">{d.score ?? "—"}</td>
                      <td dir="ltr">{d.sizing?.shares ?? "—"}</td>
                      <td dir="ltr">{amount ? money(amount) : "—"}</td>
                      <td dir="ltr">{amount ? pctOf(amount) : "—"}</td>
                      <td>{x ? EXIT_REASON_LABEL[x.reason] || x.reason : "פתוחה"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">לא נקנו עדיין מניות היום.</p>}
        <details className="skipped-details">
          <summary>דולגו היום: {skippedBySymbol.length} מניות (לחץ להצגה)</summary>
          {skippedBySymbol.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>מניה</th><th>מספר בדיקות</th><th>ציון הכי גבוה</th><th>בדיקה אחרונה</th><th>סיבה</th></tr></thead>
                <tbody>
                  {skippedBySymbol.map((r) => (
                    <tr key={r.symbol}>
                      <td dir="ltr">{r.symbol}</td>
                      <td dir="ltr">{r.checks}</td>
                      <td dir="ltr">{r.bestScore ?? "—"}</td>
                      <td>{time(r.lastAt)}</td>
                      <td>{REASON_LABEL[r.reason] || r.reasonText || r.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">לא דולגה אף מניה היום.</p>}
        </details>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>פוזיציות פתוחות</h2></div>
        {positions.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>מניה</th><th>כמות</th><th>מחיר כניסה</th><th>מחיר נוכחי</th><th>רווח/הפסד</th></tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol}>
                    <td dir="ltr">{p.symbol}</td>
                    <td dir="ltr">{fmt(Number(p.qty), 4)}</td>
                    <td dir="ltr">{money(Number(p.avg_entry_price))}</td>
                    <td dir="ltr">{money(Number(p.current_price))}</td>
                    <td dir="ltr" className={Number(p.unrealized_pl) > 0 ? "pl-up" : Number(p.unrealized_pl) < 0 ? "pl-down" : ""}>{money(Number(p.unrealized_pl))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין כרגע פוזיציות פתוחות.</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>יציאות אחרונות</h2></div>
        {exits.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>שעה</th><th>מניה</th><th>סיבה</th></tr></thead>
              <tbody>
                {exits.slice(0, 20).map((x) => (
                  <tr key={x.id}><td>{time(x.at)}</td><td dir="ltr">{x.symbol}</td><td>{EXIT_REASON_LABEL[x.reason] || x.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין עדיין יציאות.</p>}
      </section>
    </div>
  );
}

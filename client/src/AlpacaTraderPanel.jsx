import { useEffect, useRef, useState } from "react";
import { EquityChart, Hint, ago, marketStatus, useNow } from "./AlpacaPanelParts.jsx";
import { pollWhileVisible } from "./pollWhileVisible.js";

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
const SCAN_REASON_LABEL = {
  intraday_missing: "אין נר טרי", trigger_not_met: "הטריגר לא התקיים", rvol_below_threshold: "נפח יחסי נמוך", opening_range_incomplete: "טווח הפתיחה לא שלם",
  daily_missing: "חסרים נתונים יומיים", outside_window: "מחוץ לחלון הזמן", invalid_plan: "תוכנית לא תקינה", rvol_missing: "אין נפח יחסי", matched: "התאמה",
};
const EXIT_REASON_LABEL = { stop: "סטופ", breakeven_stop: "סטופ ב-break-even", partial_target: "מימוש חלקי ביעד", trailing_stop: "סטופ נגרר", carried_over: "נסגרה בפתיחה (נשארה מיום קודם)", target: "יעד", end_of_day: "סוף יום", daily_loss_breached: "הפסד יומי חרג" };

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
    trailingStopEnabled: profile.trailingStopEnabled !== false,
    breakEvenAtR: str(profile.breakEvenAtR),
    partialEnabled: profile.partialEnabled !== false,
    partialPct: str(profile.partialPct),
    partialLockR: str(profile.partialLockR),
    partialTrailR: str(profile.partialTrailR),
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
    trailingStopEnabled: f.trailingStopEnabled,
    breakEvenAtR: num(f.breakEvenAtR),
    partialEnabled: f.partialEnabled,
    partialPct: num(f.partialPct),
    partialLockR: num(f.partialLockR),
    partialTrailR: num(f.partialTrailR),
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
  const now = useNow(30000);

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
    // No polling while the tab is in the background (saves the server a request every 15s per hidden tab).
    return pollWhileVisible(load, 15000);
  }, []);

  const set = (patch) => { dirty.current = true; setForm((f) => ({ ...f, ...patch })); };
  const toggleStrategy = (key) => {
    dirty.current = true;
    setForm((f) => ({ ...f, strategies: f.strategies.includes(key) ? f.strategies.filter((s) => s !== key) : [...f.strategies, key] }));
  };

  async function toggleEntries() {
    const next = !server.profile?.enabled;
    try {
      await alpacaApi("/settings", { method: "PATCH", body: JSON.stringify({ enabled: next }) });
      setForm((f) => (f ? { ...f, enabled: next } : f));
      await load();
      onNotice?.(next ? "הכניסות החדשות חודשו" : "הכניסות החדשות הושהו. יציאות מפוזיציות קיימות ממשיכות כרגיל");
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function toggleNotify(enabled) {
    try {
      await alpacaApi("/notify", { method: "PUT", body: JSON.stringify({ enabled }) });
      await load();
      onNotice?.(enabled ? "התראות Alpaca הופעלו לפרופיל הזה" : "התראות Alpaca כובו");
    } catch (e) {
      onError?.(e.message);
    }
  }

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
  const perf = server.performance || {};
  const planFor = (symbol) => (server.plans || []).find((x) => x.symbol === symbol);
  const perfTrades = perf.trades || [];
  const stats = perf.stats || null;
  const signed = (value) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${money(value)}` : "—");
  const pctSigned = (value, digits = 2) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${fmt(value, digits)}%` : "—");
  const plClass = (value) => (value > 0 ? "pl-up" : value < 0 ? "pl-down" : "");
  const nyDay = (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const todayNy = nyDay(now);
  const todayTrades = perfTrades.filter((t) => nyDay(t.exitAt) === todayNy);
  const realizedToday = todayTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const winsToday = todayTrades.filter((t) => t.pnl > 0).length;
  const lossesToday = todayTrades.filter((t) => t.pnl < 0).length;
  const unrealizedNow = positions.reduce((sum, p) => sum + (Number(p.unrealized_pl) || 0), 0);
  const dayLimit = Number(server.day?.limit);
  const dayLoss = Number.isFinite(dayPnl) && dayPnl < 0 ? -dayPnl : 0;
  const limitUsedPct = dayLimit > 0 ? Math.min(100, (dayLoss / dayLimit) * 100) : 0;
  const market = marketStatus(now);
  const lastScanAt = server.state?.lastScanAt;
  const scanAgeMin = lastScanAt ? (now - new Date(lastScanAt).getTime()) / 60000 : null;
  const exitTickAt = server.exitLoop?.lastTickAt;
  const exitAgeMin = exitTickAt ? (now - new Date(exitTickAt).getTime()) / 60000 : null;
  const tradingOn = Boolean(server.profile?.enabled);
  const carriedOver = positions.filter((p) => {
    const at = planFor(p.symbol)?.enteredAt;
    return at && nyDay(at) < todayNy;
  });
  const warnings = [];
  if (market.open && tradingOn && scanAgeMin !== null && scanAgeMin > 10) warnings.push({ tone: "bad", text: `הסורק לא סרק כבר ${Math.round(scanAgeMin)} דקות בזמן מסחר. ייתכן שהשרת בהפעלה או תקוע.` });
  if (market.open && positions.length && (exitAgeMin === null || exitAgeMin > 2)) warnings.push({ tone: "bad", text: "בדיקת היציאות לא רצה בשתי הדקות האחרונות, בזמן שיש פוזיציות פתוחות." });
  if (carriedOver.length) warnings.push({ tone: "bad", text: `פוזיציה שנשארה מיום קודם: ${carriedOver.map((p) => p.symbol).join(", ")}. המערכת אמורה לסגור אותה בפתיחת השוק.` });
  if (server.state?.error) warnings.push({ tone: "bad", text: `שגיאה אחרונה של המנוע: ${server.state.error}` });
  if (!server.day?.breached && limitUsedPct >= 70) warnings.push({ tone: "warn", text: `ניצלת ${Math.round(limitUsedPct)}% ממגבלת ההפסד היומי.` });
  if (!tradingOn) warnings.push({ tone: "info", text: "הכניסות החדשות מושהות. יציאות מפוזיציות קיימות ממשיכות כרגיל." });
  const historyDays = server.history?.days || [];
  const tradesByDay = perfTrades.reduce((acc, t) => {
    const key = nyDay(t.exitAt);
    (acc[key] ||= []).push(t);
    return acc;
  }, {});
  const tradeFor = (d) => perfTrades.find((t) => d.orderId && t.entryOrderId === d.orderId);
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
          <h1>חשבון דמו Alpaca <span className={server.profile?.enabled ? "badge live-badge" : "badge amber"}>{server.profile?.enabled ? "מסחר פעיל" : "מסחר כבוי"}</span></h1>
          <p>סריקה עצמאית על מניות small/mid-cap תנודתיות, עם חשבון נייר (paper) נפרד ב-Alpaca. שינוי כאן לא משפיע על הצד השני.</p>
        </div>
        <button className="pause-toggle" disabled={busy || !configured} onClick={toggleEntries} title="עוצר או מחדש רק כניסות חדשות. יציאות מפוזיציות פתוחות ממשיכות כרגיל.">
          {tradingOn ? "⏸ השהה כניסות חדשות" : "▶ חדש כניסות חדשות"}
        </button>
      </div>

      <div className="status-line">
        <span className={`chip ${market.open ? "ok" : ""}`}>{market.text}</span>
        <span className={`chip ${market.open && scanAgeMin !== null && scanAgeMin > 10 ? "bad" : ""}`}>סריקה אחרונה: {ago(lastScanAt, now)}</span>
        <span className={`chip ${market.open && positions.length && (exitAgeMin === null || exitAgeMin > 2) ? "bad" : ""}`}>בדיקת יציאות: {market.open ? ago(exitTickAt, now) : "מחוץ לשעות המסחר"}</span>
        <span className={`chip ${configured && account ? "ok" : "bad"}`}>{configured && account ? "מחובר ל-Alpaca" : "אין חיבור ל-Alpaca"}</span>
      </div>
      {warnings.map((w) => (
        <div key={w.text} className={`banner ${w.tone === "bad" ? "error" : w.tone === "warn" ? "warn" : "info"}`} role={w.tone === "bad" ? "alert" : undefined}>{w.text}</div>
      ))}


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
        <h3 className="glance-title">היום במבט אחד</h3>
        <div className="risk-live">
          <div><span>רווח ממומש היום</span><b dir="ltr" className={plClass(realizedToday)}>{signed(realizedToday)}</b></div>
          <div><span>רווח/הפסד בפוזיציות פתוחות</span><b dir="ltr" className={plClass(unrealizedNow)}>{signed(unrealizedNow)}</b></div>
          <div><span>עסקאות שהסתיימו היום (הצליחו / נכשלו)</span><b dir="ltr">{todayTrades.length} ({winsToday} / {lossesToday})</b></div>
          <div><span>פוזיציות פתוחות</span><b dir="ltr">{positions.length}</b></div>
        </div>
        {dayLimit > 0 && (
          <div className="limit-meter">
            <div className="limit-label">ניצול מגבלת ההפסד היומי: <b dir="ltr">{money(dayLoss)}</b> מתוך <b dir="ltr">{money(dayLimit)}</b> <Hint>המערכת עוצרת כניסות חדשות וסוגרת את כל הפוזיציות אם ההפסד מתחילת היום מגיע למגבלה שהגדרת. הפס מראה כמה קרוב אתה אליה.</Hint></div>
            <div className="progress"><i className={limitUsedPct >= 85 ? "bad" : limitUsedPct >= 60 ? "warn" : "ok"} style={{ width: `${limitUsedPct}%` }} /></div>
          </div>
        )}
        {server.day?.breached && (
          <div className="banner error">מגבלת ההפסד היומי הופעלה. כניסות חדשות חסומות עד יום המסחר הבא; פוזיציות פתוחות נסגרות אוטומטית.</div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>פוזיציות פתוחות</h2></div>
        {positions.length ? (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>מניה</th><th>כמות</th><th>מחיר כניסה</th><th>מחיר נוכחי</th><th>סטופ</th><th>יעד</th><th>בין סטופ ליעד</th><th>רווח (R) <Hint>R הוא הסיכון בעסקה: המרחק מהכניסה עד הסטופ המקורי. "1.5R+" אומר שהרווח כרגע גדול פי 1.5 מהסכום שהיית מפסיד אילו הסטופ המקורי נפגע. היעד הוא 2R.</Hint></th><th>פתוחה</th><th>רווח/הפסד</th></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const plan = planFor(p.symbol);
                  const entryPrice = Number(p.avg_entry_price);
                  const lastPrice = Number(p.current_price);
                  const riskPerShare = entryPrice - (Number.isFinite(plan?.initialStop) ? plan.initialStop : plan?.stop);
                  const rMultiple = riskPerShare > 0 ? (lastPrice - entryPrice) / riskPerShare : null;
                  const span = plan?.target && plan?.stop ? plan.target - plan.stop : null;
                  const where = span > 0 ? Math.max(0, Math.min(100, ((lastPrice - plan.stop) / span) * 100)) : null;
                  return (
                  <tr key={p.symbol}>
                    <td data-label="מניה" dir="ltr">{p.symbol}</td>
                    <td data-label="כמות" dir="ltr">{fmt(Number(p.qty), 4)}</td>
                    <td data-label="מחיר כניסה" dir="ltr">{money(Number(p.avg_entry_price))}</td>
                    <td data-label="מחיר נוכחי" dir="ltr">{money(Number(p.current_price))}</td>
                    <td data-label="סטופ" dir="ltr">{planFor(p.symbol)?.stop ? `${money(planFor(p.symbol).stop)}${planFor(p.symbol).partialAt ? " (נגרר)" : planFor(p.symbol).breakEvenAt ? " (break-even)" : ""}` : "—"}</td>
                    <td data-label="יעד" dir="ltr">{planFor(p.symbol)?.partialAt ? "מומש חלקית" : planFor(p.symbol)?.target ? money(planFor(p.symbol).target) : "—"}</td>
                    <td data-label="בין סטופ ליעד">{where === null ? "—" : <div className="range-bar" title={`${Math.round(where)}% מהדרך בין הסטופ ליעד`}><i style={{ left: `${where}%` }} /></div>}</td>
                    <td data-label="רווח (R)" dir="ltr" className={plClass(rMultiple)}>{Number.isFinite(rMultiple) ? `${rMultiple > 0 ? "+" : ""}${fmt(rMultiple, 2)}R` : "—"}</td>
                    <td data-label="פתוחה">{plan?.enteredAt ? ago(plan.enteredAt, now).replace("לפני ", "") : "—"}</td>
                    <td data-label="רווח/הפסד" dir="ltr" className={Number(p.unrealized_pl) > 0 ? "pl-up" : Number(p.unrealized_pl) < 0 ? "pl-down" : ""}>{money(Number(p.unrealized_pl))}</td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>סה"כ</td>
                  <td colSpan={5} dir="ltr">שווי שוק: {money(investedNow)} ({pctOf(investedNow)} מהתיק)</td>
                  <td colSpan={2} />
                  <td dir="ltr" className={plClass(unrealizedNow)}>{money(unrealizedNow)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : <p className="muted">אין כרגע פוזיציות פתוחות.</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>מניות שנסרקו היום ועדיין ממתינות</h2></div>
        {candidates.length ? (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>מניה</th><th>אסטרטגיות</th><th>נפתח</th></tr></thead>
              <tbody>
                {candidates.map((b) => (
                  <tr key={b.symbol}><td data-label="מניה" dir="ltr">{b.symbol}</td><td data-label="אסטרטגיות">{[...new Set(b.signals.map((s) => s.strategy))].map((s) => STRATEGY_LABEL[s] || s).join(", ")}</td><td data-label="נפתח">{time(b.openedAt)}</td></tr>
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
            <table className="stack-table">
              <thead><tr><th>שעה</th><th>מניה</th><th>אסטרטגיה</th><th>ציון</th><th>כמות</th><th>סכום</th><th>% מהתיק</th><th>תוצאה</th></tr></thead>
              <tbody>
                {entered.map((d) => {
                  const amount = (Number(d.price) || 0) * (Number(d.sizing?.shares) || 0);
                  const x = exitFor(d);
                  const trade = tradeFor(d);
                  return (
                    <tr key={d.id}>
                      <td data-label="שעה">{time(d.at)}</td>
                      <td data-label="מניה" dir="ltr">{d.symbol}</td>
                      <td data-label="אסטרטגיה">{(d.strategies || []).map((n) => STRATEGY_LABEL[n] || n).join(", ") || "—"}</td>
                      <td data-label="ציון" dir="ltr">{d.score ?? "—"}</td>
                      <td data-label="כמות" dir="ltr">{d.sizing?.shares ?? "—"}</td>
                      <td data-label="סכום" dir="ltr">{amount ? money(amount) : "—"}</td>
                      <td data-label="% מהתיק" dir="ltr">{amount ? pctOf(amount) : "—"}</td>
                      <td data-label="תוצאה" dir="ltr" className={trade ? plClass(trade.pnl) : ""}>{trade ? `${x ? `${EXIT_REASON_LABEL[x.reason] || x.reason} ` : ""}${signed(trade.pnl)}` : x ? EXIT_REASON_LABEL[x.reason] || x.reason : "פתוחה"}</td>
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
              <table className="stack-table">
                <thead><tr><th>מניה</th><th>מספר בדיקות</th><th>ציון הכי גבוה</th><th>בדיקה אחרונה</th><th>סיבה</th></tr></thead>
                <tbody>
                  {skippedBySymbol.map((r) => (
                    <tr key={r.symbol}>
                      <td data-label="מניה" dir="ltr">{r.symbol}</td>
                      <td data-label="מספר בדיקות" dir="ltr">{r.checks}</td>
                      <td data-label="ציון הכי גבוה" dir="ltr">{r.bestScore ?? "—"}</td>
                      <td data-label="בדיקה אחרונה">{time(r.lastAt)}</td>
                      <td data-label="סיבה">{REASON_LABEL[r.reason] || r.reasonText || r.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">לא דולגה אף מניה היום.</p>}
        </details>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>סיכום ביצועים ({perf.windowDays || 14} ימים אחרונים)</h2></div>
        {stats && stats.overall.trades ? (
          <>
            <div className="risk-live">
              <div><span>עסקאות שהסתיימו</span><b dir="ltr">{stats.overall.trades}</b></div>
              <div><span>הצליחו / נכשלו</span><b dir="ltr">{stats.overall.wins} / {stats.overall.losses} ({fmt(stats.overall.winRatePct, 0)}%)</b></div>
              <div><span>רווח/הפסד כולל</span><b dir="ltr" className={plClass(stats.overall.totalPnl)}>{signed(stats.overall.totalPnl)}</b></div>
              <div><span>רווח ממוצע / הפסד ממוצע</span><b dir="ltr">{signed(stats.overall.avgWin)} / {signed(stats.overall.avgLoss)}</b></div>
              <div><span>פער ממוצע בין מחיר מתוכנן למחיר ביצוע <Hint>נקרא גם slippage. האיתות מחליט לקנות במחיר מסוים, אבל עד שהפקודה מתבצעת המחיר זז. פער חיובי אומר ששילמנו יותר מהמתוכנן. פער גדול הורס חלק גדול מהרווח לפני שהעסקה התחילה.</Hint></span><b dir="ltr">{pctSigned(stats.overall.avgSlippagePct)}</b></div>
            </div>
            <div className="table-wrap">
              <table className="stack-table">
                <thead><tr><th>אסטרטגיה</th><th>עסקאות</th><th>הצליחו</th><th>נכשלו</th><th>% הצלחה</th><th>רווח/הפסד כולל</th><th>ממוצע לעסקה</th></tr></thead>
                <tbody>
                  {stats.byStrategy.map((r) => (
                    <tr key={r.strategy}>
                      <td data-label="אסטרטגיה">{STRATEGY_LABEL[r.strategy] || (r.strategy === "unknown" ? "לא ידוע" : r.strategy)}</td>
                      <td data-label="עסקאות" dir="ltr">{r.trades}</td>
                      <td data-label="הצליחו" dir="ltr">{r.wins}</td>
                      <td data-label="נכשלו" dir="ltr">{r.losses}</td>
                      <td data-label="% הצלחה" dir="ltr">{fmt(r.winRatePct, 0)}%</td>
                      <td data-label="רווח/הפסד כולל" dir="ltr" className={plClass(r.totalPnl)}>{signed(r.totalPnl)}</td>
                      <td data-label="ממוצע לעסקה" dir="ltr" className={plClass(r.totalPnl)}>{signed(r.totalPnl / r.trades)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">מחושב מההזמנות שבוצעו בפועל ב-Alpaca. כמה עסקאות הן מעט מדי כדי להסיק מסקנות; כדאי להסתכל על מגמה אחרי שבועיים-שלושה.</p>
          </>
        ) : <p className="muted">{perf.error ? `לא ניתן לטעון ביצועים: ${perf.error}` : "אין עדיין עסקאות שהסתיימו."}</p>}
      </section>

      <section className="panel">
        <div className="section-heading"><h2>היסטוריה לפי יום</h2></div>
        <EquityChart days={historyDays} liveEquity={equity} startValue={server.history?.baseValue} />
        {historyDays.length ? (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>יום</th><th>שווי בסוף היום</th><th>רווח/הפסד</th><th>%</th><th>עסקאות</th><th>הצליחו</th></tr></thead>
              <tbody>
                {[...historyDays].reverse().slice(0, 14).map((d) => {
                  const dayTrades = tradesByDay[d.date] || [];
                  const wins = dayTrades.filter((t) => t.pnl > 0).length;
                  return (
                    <tr key={d.date}>
                      <td data-label="יום" dir="ltr">{d.date.slice(5).split("-").reverse().join(".")}</td>
                      <td data-label="שווי בסוף היום" dir="ltr">{money(d.equity)}</td>
                      <td data-label="רווח/הפסד" dir="ltr" className={plClass(d.profitLoss)}>{signed(d.profitLoss)}</td>
                      <td data-label="%" dir="ltr" className={plClass(d.profitLossPct)}>{pctSigned(d.profitLossPct)}</td>
                      <td data-label="עסקאות" dir="ltr">{dayTrades.length || "—"}</td>
                      <td data-label="הצליחו" dir="ltr">{dayTrades.length ? `${wins} / ${dayTrades.length}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="muted">נלקח מההיסטוריה של Alpaca (ערך סוף יום). מספר העסקאות מחושב מההזמנות שבוצעו.</p>
      </section>

      <details className="panel collapsible-panel">
        <summary>עסקאות שהסתיימו ({perfTrades.length})</summary>
        {perfTrades.length ? (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>יציאה</th><th>מניה</th><th>אסטרטגיה</th><th>כמות</th><th>מחיר כניסה</th><th>מחיר יציאה</th><th>סכום</th><th>רווח/הפסד</th><th>%</th><th>פער ביצוע</th><th>סיבה</th></tr></thead>
              <tbody>
                {perfTrades.slice(0, 40).map((t) => (
                  <tr key={`${t.entryOrderId}:${t.exitOrderId}`}>
                    <td data-label="יציאה">{new Date(t.exitAt).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td data-label="מניה" dir="ltr">{t.symbol}</td>
                    <td data-label="אסטרטגיה">{STRATEGY_LABEL[t.strategy] || t.strategy || "—"}</td>
                    <td data-label="כמות" dir="ltr">{fmt(t.qty, 0)}</td>
                    <td data-label="מחיר כניסה" dir="ltr">{money(t.entryPrice)}</td>
                    <td data-label="מחיר יציאה" dir="ltr">{money(t.exitPrice)}</td>
                    <td data-label="סכום" dir="ltr">{money(t.amount)}</td>
                    <td data-label="רווח/הפסד" dir="ltr" className={plClass(t.pnl)}>{signed(t.pnl)}</td>
                    <td data-label="%" dir="ltr" className={plClass(t.pnl)}>{pctSigned(t.pnlPct)}</td>
                    <td data-label="פער ביצוע" dir="ltr">{pctSigned(t.slippagePct)}</td>
                    <td data-label="סיבה">{EXIT_REASON_LABEL[t.exitReason] || t.exitReason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין עדיין עסקאות שהסתיימו.</p>}
      </details>

      <details className="panel collapsible-panel">
        <summary>יציאות אחרונות ({exits.length})</summary>
        {exits.length ? (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>שעה</th><th>מניה</th><th>סיבה</th></tr></thead>
              <tbody>
                {exits.slice(0, 20).map((x) => (
                  <tr key={x.id}><td data-label="שעה">{time(x.at)}</td><td data-label="מניה" dir="ltr">{x.symbol}</td><td data-label="סיבה">{EXIT_REASON_LABEL[x.reason] || x.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">אין עדיין יציאות.</p>}
      </details>

      <section className="panel">
        <div className="section-heading"><h2>סריקות אחרונות</h2></div>
        <details className="skipped-details">
          <summary>למה לא נקנה? מה כל סריקה מצאה ({(server.scans || []).length})</summary>
          {(server.scans || []).length ? (
            <div className="table-wrap">
              <table className="stack-table">
                <thead><tr><th>שעה</th><th>נבדקו</th><th>התאמות</th><th>נפח יחסי מעל 1.2</th><th>נכנסו</th><th>הסיבות העיקריות לפסילה</th></tr></thead>
                <tbody>
                  {(server.scans || []).map((s) => (
                    <tr key={s.id}>
                      <td data-label="שעה">{time(s.at)}</td>
                      <td data-label="נבדקו" dir="ltr">{s.evaluated}</td>
                      <td data-label="התאמות" dir="ltr">{s.matched}</td>
                      <td data-label="נפח יחסי מעל 1.2" dir="ltr">{s.rvolOver1_2 ?? "—"}</td>
                      <td data-label="נכנסו" dir="ltr">{s.entered}</td>
                      <td data-label="הסיבות העיקריות לפסילה">{Object.entries(s.reasons || {}).filter(([code]) => code !== "matched").sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, n]) => `${SCAN_REASON_LABEL[code] || code}: ${n}`).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">עדיין אין סריקות מתועדות.</p>}
        </details>
      </section>

      <details className="panel settings-group">
        <summary>הגדרות (הפעלה, התראות, סטופ נגרר, סיכון, אסטרטגיות ועוד){dirty.current ? " · יש שינויים שלא נשמרו" : ""}</summary>
        <div className="risk-panel">
      <section className="panel">
        <div className="section-heading"><h2>הפעלה</h2></div>
        <label className="inline">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          מסחר פעיל בחשבון Alpaca (סריקה רצה תמיד; כיבוי כאן עוצר רק כניסות חדשות, לא מעקב אחרי פוזיציות קיימות)
        </label>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>התראות</h2></div>
        <label className="inline">
          <input type="checkbox" checked={Boolean(server.notify?.enabled)} onChange={(e) => toggleNotify(e.target.checked)} />
          שלח לי התראה קופצת על כל קנייה וכל יציאה בחשבון Alpaca
        </label>
        <p className="muted">ההתראות מגיעות למכשירים שבהם אישרת התראות באתר. ההגדרה נשמרת מיד ושייכת לפרופיל הזה בלבד.</p>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>סטופ נגרר <Hint>כשהעסקה מרוויחה סכום השווה לסיכון המקורי (1R), הסטופ עובר למחיר הכניסה (break-even, נקודת איזון). מאותו רגע עסקה שהייתה ברווח לא יכולה להפוך להפסד: במקרה הגרוע תצא בלי הפסד.</Hint></h2></div>
        <label className="inline">
          <input type="checkbox" checked={form.trailingStopEnabled} onChange={(e) => set({ trailingStopEnabled: e.target.checked })} />
          להעביר את הסטופ לנקודת הכניסה (break-even) כשהעסקה מרוויחה מספיק, כדי שעסקה שהייתה ברווח לא תהפוך להפסד
        </label>
        <div className="risk-fields">
          <label>העברה אחרי רווח של (כפולות הסיכון, 1 = כמו הסיכון המקורי)<input dir="ltr" inputMode="decimal" value={form.breakEvenAtR} onChange={(e) => set({ breakEvenAtR: e.target.value })} /></label>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>מימוש חלקי ביעד <Hint>כשהמחיר מגיע ליעד (2R) נמכר חלק מהמניות כדי לנעול רווח. לשאר אין יעד קבוע: הסטופ שלהן עולה, ואחר כך מלווה את המחיר מלמטה במרחק קבוע, כך שרווח גדול יכול לרוץ ולא נחתך מוקדם.</Hint></h2></div>
        <label className="inline">
          <input type="checkbox" checked={form.partialEnabled} onChange={(e) => set({ partialEnabled: e.target.checked })} />
          כשהעסקה מגיעה ליעד (2R): למכור חלק, ולהשאיר את השאר בלי יעד קבוע עם סטופ שעולה עם המחיר
        </label>
        <div className="risk-fields">
          <label>אחוז למכור ביעד (%)<input dir="ltr" inputMode="decimal" value={form.partialPct} onChange={(e) => set({ partialPct: e.target.value })} /></label>
          <label>רווח שננעל לשאר (כפולות סיכון)<input dir="ltr" inputMode="decimal" value={form.partialLockR} onChange={(e) => set({ partialLockR: e.target.value })} /></label>
          <label>מרחק הסטופ הנגרר מהשיא (כפולות סיכון)<input dir="ltr" inputMode="decimal" value={form.partialTrailR} onChange={(e) => set({ partialTrailR: e.target.value })} /></label>
        </div>
        <p className="muted">דוגמה: כניסה ב-100, סטופ ב-98 (סיכון 2), יעד ב-104. ביעד נמכרת מחצית. לשאר הסטופ עולה ל-102 לפחות (רווח של 1R) ואחר כך מלווה את השיא במרחק 2. בלי יעד נוסף.</p>
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

          <div className="settings-actions">
            <button className="primary" disabled={busy || saving || !dirty.current} onClick={save}>
              {saving ? "שומר..." : "שמור הגדרות"}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

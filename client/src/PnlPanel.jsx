import { useEffect, useState } from "react";

// Realized profit/loss by period. Figures come from the closed deals the MT4 EA reports; the server
// assigns each deal to a New York trading date. Weeks run Monday to Friday. Open positions are not included.

const PERIODS = [
  ["day", "יומי"],
  ["week", "שבועי"],
  ["month", "חודשי"],
  ["quarter", "רבעוני"],
  ["year", "שנתי"],
];
const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", timeZone: "UTC" });

export default function PnlPanel({ executionApi, mt4Positions }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState("day");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await executionApi("/pnl");
        if (live) {
          setData(next);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const current = data?.periods?.[period];
  const series = data?.series || [];
  const maxAbs = Math.max(1, ...series.map((d) => Math.abs(d.pnl)));
  const open = mt4Positions?.fresh && Number.isFinite(mt4Positions.profit) ? mt4Positions.profit : null;
  const winRate = current && current.wins + current.losses > 0 ? Math.round((current.wins / (current.wins + current.losses)) * 100) : null;

  return (
    <section className="pnl-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">חשבון דמו · לפי תאריכי מסחר בניו יורק</span>
          <h1>רווח והפסד</h1>
          <p>רווח או הפסד שנסגר בפועל, לפי תקופה. שבוע מסחר הוא שני עד שישי. פוזיציות פתוחות אינן נכללות בסכומים ומוצגות בנפרד.</p>
        </div>
      </div>

      <div className="panel">
        <div className="pnl-tabs" role="tablist" aria-label="תקופה">
          {PERIODS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={period === key} className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>
              {label}
            </button>
          ))}
        </div>

        {failed && !data && <p className="pnl-note">אין חיבור לשרת כרגע.</p>}
        {data && current && (
          <div className="pnl-summary">
            <div className="pnl-main">
              <span>{PERIODS.find(([k]) => k === period)[1]} · נסגר</span>
              <strong dir="ltr" className={current.pnl >= 0 ? "pl-up" : "pl-down"}>{current.pnl > 0 ? "+" : ""}{fmt(current.pnl)}</strong>
              <small dir="ltr">{current.from === current.to ? current.from : `${current.from} → ${current.to}`}</small>
            </div>
            <div><span>עסקאות שנסגרו</span><strong>{current.trades}</strong></div>
            <div><span>ברווח / בהפסד</span><strong>{current.wins} / {current.losses}</strong></div>
            <div><span>אחוז עסקאות מרוויחות</span><strong>{winRate != null ? `${winRate}%` : "—"}</strong></div>
            <div><span>פתוחות עכשיו</span><strong dir="ltr" className={open != null ? (open >= 0 ? "pl-up" : "pl-down") : ""}>{open != null ? fmt(open) : "—"}</strong></div>
          </div>
        )}
        {data && data.daysRecorded === 0 && (
          <p className="pnl-note">עדיין לא נרשמו עסקאות שנסגרו. הנתונים מצטברים אוטומטית מרגע שה־EA מדווח, ולכן מדובר בהיסטוריה חדשה שמתחילה עכשיו.</p>
        )}
      </div>

      <div className="panel">
        <h2>30 הימים האחרונים</h2>
        {series.length === 0 ? (
          <p className="pnl-note">אין נתונים להצגה.</p>
        ) : (
          <div className="pnl-chart" role="img" aria-label="רווח והפסד יומי">
            {series.map((d) => (
              <div key={d.date} className="pnl-bar-col" title={`${d.date}: ${fmt(d.pnl)} · ${d.trades} עסקאות`}>
                <div className="pnl-bar-area">
                  <div className="pnl-half top">{d.pnl > 0 && <div className="pnl-bar up" style={{ height: `${(d.pnl / maxAbs) * 100}%` }} />}</div>
                  <div className="pnl-half bottom">{d.pnl < 0 && <div className="pnl-bar down" style={{ height: `${(Math.abs(d.pnl) / maxAbs) * 100}%` }} />}</div>
                </div>
                <small>{dayLabel(d.date)}</small>
              </div>
            ))}
          </div>
        )}
        <p className="pnl-note">הנתונים מדווחים על ידי MT4. אם ה־EA כבוי או לא הצליח לקבוע את שעון הברוקר, יום לא יירשם עד לדיווח הבא.</p>
      </div>
    </section>
  );
}

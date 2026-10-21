import { useEffect, useState } from "react";

// Entry and exit decisions in one compact, scrollable window: the latest few rows are visible, older ones are a scroll away.
const LABEL = {
  entered: "כניסה", skipped: "דולגה", ignored: "התעלמות",
  exit_close: "יציאה", exit_partial: "מכירה חלקית", stop_moved: "הזזת סטופ", exit_skipped: "מדרגה דולגה", exit_error: "תקלה בניהול", closed: "נסגרה",
};
const GOOD = new Set(["entered"]);

export default function DecisionLog({ executionApi }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => executionApi("/decisions?limit=150").then((r) => alive && setRows(r.decisions || [])).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <section className="panel decision-log">
      <div className="section-heading"><h2>יומן החלטות</h2><span className="badge">{rows ? rows.length : "…"}</span></div>
      {rows && rows.length ? (
        <div className="decision-scroll">
          <table>
            <thead><tr><th>תאריך ושעה</th><th>מניה</th><th>סוג</th><th>החלטה</th><th>ציון</th><th>כמות</th><th>למה</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{new Date(d.at).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td dir="ltr">{d.symbol}</td>
                  <td>{d.kind === "exit" ? "יציאה" : "כניסה"}</td>
                  <td className={GOOD.has(d.outcome) ? "pl-up" : d.outcome === "closed" ? (d.profit >= 0 ? "pl-up" : "pl-down") : ""}>{LABEL[d.outcome] || d.outcome}</td>
                  <td>{d.score ?? "—"}</td>
                  <td>{d.sizing?.shares ?? d.qty ?? "—"}</td>
                  <td>{d.reasonText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{rows ? "עדיין לא התקבלו החלטות. כל כניסה, יציאה ודילוג יירשמו כאן עם הסיבה." : "טוען…"}</p>
      )}
    </section>
  );
}

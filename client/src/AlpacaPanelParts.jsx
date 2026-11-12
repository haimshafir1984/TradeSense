import { useEffect, useState } from "react";

// Small presentational helpers for the Alpaca tab (kept apart from AlpacaTraderPanel.jsx so that file stays readable).

// A "?" that opens a short explanation under it. Works with a tap on a phone, where hover tooltips do not exist.
export function Hint({ children }) {
  return (
    <details className="hint">
      <summary aria-label="הסבר">?</summary>
      <span>{children}</span>
    </details>
  );
}

// Re-renders the caller every `ms` so relative times ("לפני 3 דקות") stay current without waiting for the next poll.
export function useNow(ms = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function ago(from, now) {
  const at = from ? new Date(from).getTime() : NaN;
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `לפני ${seconds} שנ׳`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `לפני ${minutes} דק׳`;
  return `לפני ${Math.round(minutes / 60)} שעות`;
}

function nyClock(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { dow, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

function span(minutes) {
  if (minutes < 60) return `${minutes} דק׳`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return m ? `${h} שעות ו-${m} דק׳` : `${h} שעות`;
  return `${Math.round(h / 24)} ימים`;
}

// US regular session (weekdays 09:30-16:00 New York). Exchange holidays are not known here, so on a holiday this says
// "open" while the server's own scan stays idle.
export function marketStatus(ms) {
  const { dow, minutes } = nyClock(ms);
  const weekday = dow >= 1 && dow <= 5;
  if (weekday && minutes >= OPEN && minutes < CLOSE) return { open: true, text: `השוק פתוח, נסגר בעוד ${span(CLOSE - minutes)}` };
  for (let d = 0; d <= 7; d += 1) {
    const target = (dow + d) % 7;
    if (target >= 1 && target <= 5 && (d > 0 || minutes < OPEN)) return { open: false, text: `השוק סגור, נפתח בעוד ${span(d * 1440 + OPEN - minutes)}` };
  }
  return { open: false, text: "השוק סגור" };
}

// Equity curve as a plain inline SVG (no chart library): one point per trading day, the live value as the last point.
export function EquityChart({ days, liveEquity, startValue }) {
  const points = [...days.map((d) => ({ label: d.date, value: d.equity }))];
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isFinite(liveEquity) && (!points.length || points[points.length - 1].label < today)) points.push({ label: today, value: liveEquity });
  if (points.length < 2) return <p className="muted">העקומה תופיע אחרי שיהיו לפחות שני ימי מסחר.</p>;
  const values = points.map((p) => p.value);
  if (Number.isFinite(startValue)) values.push(startValue);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const W = 600;
  const H = 170;
  const x = (i) => 10 + (i * (W - 20)) / (points.length - 1);
  const y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 28);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const up = last.value >= (Number.isFinite(startValue) ? startValue : points[0].value);
  return (
    <svg className={`equity-chart ${up ? "up" : "down"}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="עקומת שווי החשבון">
      {Number.isFinite(startValue) && <line x1="10" x2={W - 10} y1={y(startValue)} y2={y(startValue)} className="equity-base" />}
      <polyline points={line} className="equity-line" fill="none" />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r="4" className="equity-dot" />
      <text x="12" y="14" className="equity-label" direction="ltr">{`$${Math.round(max).toLocaleString("en-US")}`}</text>
      <text x="12" y={H - 3} className="equity-label" direction="ltr">{`$${Math.round(min).toLocaleString("en-US")}`}</text>
    </svg>
  );
}

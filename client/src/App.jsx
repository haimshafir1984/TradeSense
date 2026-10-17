import { useEffect, useRef, useState } from "react";
import RiskPanel from "./RiskPanel.jsx";
import PnlPanel from "./PnlPanel.jsx";
// Production builds default to same-origin (the API serves this site); dev talks to :4000.
const BASE = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? "" : "http://localhost:4000");
const money = (n) =>
  Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n)
    : "—";
const number = (n) =>
  Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(n)
    : "—";
const amount = (n) =>
  Number.isFinite(n)
    ? n > 0 && n < 0.01
      ? `$${n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`
      : money(n)
    : "—";
const time = (s) =>
  s
    ? new Date(s).toLocaleString("he-IL", {
        timeZone: "Asia/Jerusalem",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "טרם עודכן";
const names = {
  stop: "סטופ",
  target: "יעד",
  time: "סיום זמן",
  reported: "דיווח שלך",
};

export default function App() {
  const [data, setData] = useState(null),
    [tab, setTab] = useState("trades"),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [auth, setAuth] = useState(false),
    [code, setCode] = useState(""),
    [modal, setModal] = useState(null),
    [legacy, setLegacy] = useState(null),
    [executionOrders, setExecutionOrders] = useState(null),
    [executionState, setExecutionState] = useState(null),
    [mt4Positions, setMt4Positions] = useState(null),
    [closeRequests, setCloseRequests] = useState([]);
  useEffect(() => {
    if (tab === "trades")
      api("/legacy")
        .then(setLegacy)
        .catch(() => {});
  }, [tab]);
  const token = useRef(
    localStorage.getItem("tradesense.access") ||
      sessionStorage.getItem("tradesense.access") ||
      "",
  );
  const userId = useRef(localStorage.getItem("tradesense.user") || "");
  async function api(path, options = {}) {
    const response = await fetch(`${BASE}/api/autopilot${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token.current ? { Authorization: `Bearer ${token.current}` } : {}),
        ...(userId.current ? { "X-TradeSense-User": userId.current } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) {
      setAuth(true);
      throw new Error("יש להזין את קוד הגישה למערכת");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "הבקשה לא הושלמה");
    if (result.userId && result.userId !== userId.current) {
      userId.current = result.userId;
      localStorage.setItem("tradesense.user", result.userId);
    }
    return result;
  }
  async function executionApi(path, options = {}) {
    const response = await fetch(`${BASE}/api/execution${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token.current ? { Authorization: `Bearer ${token.current}` } : {}),
        ...(userId.current ? { "X-TradeSense-User": userId.current } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "פקודות הביצוע אינן זמינות");
    return result;
  }
  async function login(event) {
    event.preventDefault();
    token.current = code;
    localStorage.setItem("tradesense.access", code);
    await act(
      () =>
        api("/session", {
          method: "POST",
          body: JSON.stringify({ userId: userId.current, code }),
        }),
      "הכניסה נשמרה למכשיר הזה",
    );
    await load();
  }
  async function load() {
    try {
      const result = await api("/dashboard");
      setData(result);
      setAuth(false);
      setError("");
      try {
        const queue = await executionApi("/orders");
        setExecutionOrders(queue.orders || []);
      } catch {
        setExecutionOrders(null);
      }
      try {
        setExecutionState(await executionApi("/control"));
      } catch {
        setExecutionState(null);
      }
      try {
        setMt4Positions(await executionApi("/positions"));
      } catch {
        setMt4Positions(null);
      }
      try {
        setCloseRequests((await executionApi("/close-requests")).requests || []);
      } catch {
        setCloseRequests([]);
      }
    } catch (e) {
      setError(
        e.name === "TimeoutError"
          ? "השרת לא הגיב בזמן. מנסים שוב אוטומטית."
          : e.message,
      );
    }
  }
  async function loadMoreRecommendations() {
    if (!data?.recommendationNextCursor) return;
    setBusy(true);
    setError("");
    try {
      const page = await api(
        `/recommendations?limit=25&cursor=${encodeURIComponent(data.recommendationNextCursor)}`,
      );
      setData((current) => ({
        ...current,
        recommendations: [...(current?.recommendations || []), ...(page.rows || [])],
        recommendationNextCursor: page.nextCursor || null,
      }));
      setNotice("היסטוריית ההמלצות עודכנה");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);
  async function act(fn, message) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setNotice(message || "נשמר");
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw new Error(
        "הדפדפן לא תומך בהתראות. ב־iPhone יש להוסיף למסך הבית ולפתוח משם.",
      );
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error("יש לאפשר התראות בהגדרות הדפדפן");
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const { publicKey } = await api("/push/key");
    const key = Uint8Array.from(
      atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      }));
    await api("/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription),
    });
    await api("/push/test", { method: "POST" });
  }
  async function closePosition(p) {
    const sideText = p.side === "buy" ? "קנייה" : "מכירה";
    const sure = window.confirm(
      `לסגור את הפוזיציה ${p.symbol} (${sideText}, ${p.lots})?\nרווח/הפסד נוכחי: ${p.profit ?? "לא זמין"}\nהסגירה מתבצעת בחשבון הדמו ב־MT4 ואין דרך לבטל אותה.`,
    );
    if (!sure) return;
    await act(
      () =>
        executionApi(`/positions/${encodeURIComponent(p.ticket)}/close`, {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        }),
      "בקשת הסגירה נשלחה ל־MT4. היא תתבצע כשה־EA במצב ביצוע, בדרך כלל תוך כ־15 שניות",
    );
  }
  const runtime = data?.runtime || {},
    settings = data?.settings,
    storage = data?.storage || {};
  const diagnostics = runtime.diagnostics || {},
    marketDiagnostics = runtime.marketDiagnostics || {},
    universeStatus = marketDiagnostics.universe || {},
    selectionStatus = marketDiagnostics.selection || {},
    candidates = data?.candidates || [];
  const active = (data?.signals || []).filter(
    (s) =>
      s.status === "active" &&
      Date.parse(s.expiresAt) > Date.now() &&
      Date.now() - Date.parse(s.priceAt) <= 90000,
  );
  const open = (data?.trades || []).filter(
    (t) => t.source === "personal" && t.status === "open",
  );
  const visible = active.filter((s) => filter === "all" || s.mode === filter);
  const strategy = (k) => data?.strategies.find((s) => s.key === k);
  const enabled = settings?.enabled;
  return (
    <div className="app" dir="rtl">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <span>
            TradeSense<small>המסחר שלך. תמונה ברורה.</small>
          </span>
        </div>
        <div className="market-pill">
          <i className={runtime.marketOpen === true ? "dot live" : "dot"} />
          {runtime.marketOpen === true
            ? "השוק האמריקאי פתוח"
            : runtime.marketOpen === false
              ? "השוק האמריקאי סגור"
              : "מצב השוק: לא זמין"}
        </div>
        <button
          className={data?.systemPaused ? "system-switch paused" : "system-switch"}
          disabled={busy}
          onClick={() =>
            act(
              () =>
                api("/system", {
                  method: "POST",
                  body: JSON.stringify({ paused: !data?.systemPaused }),
                }),
              data?.systemPaused ? "המערכת הופעלה" : "המערכת כובתה",
            )
          }
        >
          {data?.systemPaused ? "⏻ המערכת כבויה — להפעלה" : "⏻ כיבוי מערכת"}
        </button>
        <span className="broker-label">
          ביצוע ידני אצל הברוקר שלך
        </span>
      </header>
      {storage.ephemeral && (
        <div className="banner error storage-banner" role="alert">
          <div>
            <strong>⚠ אחסון השרת זמני — היסטוריית איתותים ועסקאות עלולות להימחק, והתראות Push עלולות להפסיק לעבוד, בכל הפעלה מחדש של השרת.</strong>
            <span>יש לוודא ב-Render שדיסק קבוע מחובר ב-Mount Path בדיוק /var/data, ושמשתנה הסביבה AUTOPILOT_DB_PATH מצביע עליו. פירוט: docs/DEPLOYMENT.md.</span>
          </div>
        </div>
      )}
      <StatusRibbon data={data} executionState={executionState} mt4Positions={mt4Positions} />
      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label="ניווט ראשי">
            {[ 
              ["trades", "↗", "עסקאות פתוחות"],
              ["terminal", "⌂", "מרכז שליטה"],
              ["risk", "⚖", "ניהול סיכונים"],
              ["pnl", "₪", "רווח והפסד"],
              ["today", "◎", "הזדמנויות היום"],
              ["results", "▤", "היסטוריית עסקאות"],
              ["settings", "⚙", "הגדרות"],
              ["activity", "≋", "יומן פעילות"],
            ].map(([key, icon, label]) => (
              <button
                key={key}
                className={`${tab === key ? "nav-item selected" : "nav-item"}${key === "trades" ? " priority" : ""}`}
                onClick={() => setTab(key)}
              >
                <span>{icon}</span>
                {label}
                {key === "trades" && open.length > 0 ? (
                  <b className="count">{open.length}</b>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <span className="eyebrow">שוק אחד, מקום אחד</span>
            <p>
              מניות בארה״ב
              <br />
              NASDAQ · NYSE
            </p>
            <small>
              המערכת עוקבת ומתריעה.
              <br />
              את העסקאות מבצעים אצל הברוקר שלך.
            </small>
          </div>
        </aside>
        <main>
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="banner success" role="status">
              {notice}
              <button
                className="icon-button"
                aria-label="סגור הודעה"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}
          {auth ? (
            <form className="panel login" onSubmit={login}>
              <h1>כניסה למערכת שלך</h1>
              <p>
                בפעם הראשונה בחר קוד פשוט. הקוד נשמר במכשיר הזה והכניסות הבאות
                ייפתחו אוטומטית באותו דפדפן.
              </p>
              <label>
                קוד גישה
                <input
                  type="password"
                  autoComplete="current-password"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </label>
              <button className="primary">כניסה</button>
            </form>
          ) : !data ? (
            <div className="panel empty">
              <span className="empty-icon">◎</span>
              <h2>מתחברים למערכת שלך</h2>
              <p>הנתונים יופיעו כאן כשהשרת יהיה זמין.</p>
              <button onClick={load}>נסה שוב</button>
            </div>
          ) : (
            <>
              {tab === "terminal" && (
                <ControlTerminal
                  data={data}
                  executionOrders={executionOrders}
                  executionState={executionState}
                  mt4Positions={mt4Positions}
                  busy={busy}
                  onStart={() =>
                    act(
                      () => api("/system", { method: "POST", body: JSON.stringify({ paused: false }) }),
                      "מנוע האיתותים הופעל",
                    )
                  }
                  onStop={() =>
                    act(
                      () => api("/system", { method: "POST", body: JSON.stringify({ paused: true }) }),
                      "מנוע האיתותים נעצר",
                    )
                  }
                  onSettings={() => setTab("settings")}
                  onAutonomousStart={() => {
                    const sure = window.confirm(
                      `להפעיל מסחר עצמאי בחשבון הדמו?\nהמערכת תשלח פקודות ל־MT4 לפי האיתותים, בתוך המגבלות: עד ${settings?.maxPositions ?? "?"} פוזיציות, הפסד יומי מרבי ${settings?.dailyLossPct ?? "?"}%.\nאפשר לעצור בכל רגע בכפתור עצירת חירום.`,
                    );
                    if (!sure) return;
                    return act(
                      () => executionApi("/control", { method: "POST", body: JSON.stringify({ mode: "autonomous" }) }),
                      "מסחר עצמאי הופעל בשרת",
                    );
                  }}
                  onAutonomousStop={() =>
                    act(
                      () => executionApi("/control", { method: "POST", body: JSON.stringify({ mode: "scanner" }) }),
                      "מסחר עצמאי נעצר; הסריקה יכולה להמשיך",
                    )
                  }
                  onEmergencyStop={() =>
                    act(
                      () => executionApi("/control", { method: "POST", body: JSON.stringify({ mode: "off" }) }),
                      "מסחר עצמאי נעצר",
                    )
                  }
                />
              )}
              {!settings.setupComplete && (
                <div className="setup-strip">
                  <div>
                    <strong>מתחילים מהחשבון שלך</strong>
                    <p>
                      הגדר את ההון הזמין. המעקב הסימולטיבי כבר יכול
                      לעבוד ברקע.
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => setTab("settings")}
                  >
                    הגדרה ראשונית ←
                  </button>
                </div>
              )}
              {tab === "pnl" && <PnlPanel executionApi={executionApi} mt4Positions={mt4Positions} />}
              {tab === "risk" && (
                <RiskPanel
                  executionApi={executionApi}
                  executionState={executionState}
                  mt4Positions={mt4Positions}
                  busy={busy}
                  onNotice={setNotice}
                  onError={setError}
                />
              )}
              {tab === "today" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        תמונת מצב ·{" "}
                        {new Date().toLocaleDateString("he-IL", {
                          weekday: "long",
                          day: "numeric",
                          month: "long",
                        })}
                      </span>
                      <h1>הזדמנויות היום</h1>
                      <p>איתותים קצרים, תוכנית ברורה, וההחלטה נשארת אצלך.</p>
                    </div>
                    <button
                      disabled={busy || runtime.scanning || !runtime.marketOpen}
                      onClick={() =>
                        act(
                          () => api("/scan", { method: "POST" }),
                          "בקשת העדכון התקבלה. הסריקה מתבצעת בשעות הפעילות.",
                        )
                      }
                      className="secondary"
                    >
                      {runtime.scanning ? "הסריקה מתבצעת…" : "↻ עדכון עכשיו"}
                    </button>
                  </div>
                  <div className="metrics">
                    <Metric
                      label="איתותים בתוקף"
                      value={active.length}
                      sub="מתעדכנים אוטומטית"
                    />
                    <Metric
                      label="מניות במאגר"
                      value={number(universeStatus.size ?? diagnostics.universeSize)}
                      sub={
                        universeStatus.running
                          ? "מכין נתוני שוק"
                          : "סינון יומי לפי SIP"
                      }
                    />
                    <Metric
                      label="נבדקו במחזור"
                      value={number(diagnostics.evaluatedCount)}
                      sub={`סריקה אחרונה: ${time(runtime.lastScanAt)}`}
                    />
                  </div>
                  <div
                    className={`automation-bar ${runtime.error ? "warning" : ""}`}
                  >
                    <i
                      className={
                        enabled && runtime.healthy && !runtime.error
                          ? "dot live"
                          : "dot"
                      }
                    />
                    <div>
                      <strong>
                        {data?.systemPaused
                          ? "המערכת כבויה — אין סריקות או התראות חדשות"
                          : !runtime.healthy
                          ? "אין כרגע חיבור פעיל למנוע"
                          : runtime.error
                            ? "נדרשת תשומת לב לנתונים"
                            : enabled
                              ? "האוטומציה פועלת ברקע"
                              : "איתותים חדשים מושהים"}
                      </strong>
                      <span>
                        {runtime.error ||
                          (!runtime.marketOpen
                            ? `פתיחה הבאה: ${time(runtime.nextOpen)}`
                            : `סריקה אחרונה: ${time(runtime.lastScanAt)}`)}
                      </span>
                    </div>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () =>
                            api("/settings", {
                              method: "PATCH",
                              body: JSON.stringify({ enabled: !enabled }),
                            }),
                          enabled
                            ? "איתותים חדשים הושהו; המעקב אחר עסקאות נמשך"
                            : "האוטומציה הופעלה",
                        )
                      }
                    >
                      {enabled ? "השהה איתותים" : "הפעל איתותים"}
                    </button>
                  </div>
                  <div className="section-heading">
                    <h2>מה רלוונטי עכשיו</h2>
                    <div className="segments" aria-label="סינון לפי אופק">
                      {[
                        ["all", "הכול"],
                        ["day", "יומי"],
                        ["swing", "עד 5 ימים"],
                      ].map(([k, l]) => (
                        <button
                          className={filter === k ? "active" : ""}
                          key={k}
                          onClick={() => setFilter(k)}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  {visible.length ? (
                    <div className="signal-grid">
                      {visible.map((s) => (
                        <Signal
                          key={s.id}
                          s={s}
                          label={strategy(s.strategy)?.label}
                          onEntry={() => setModal({ kind: "entry", signal: s })}
                          onCopy={() =>
                            act(
                              () =>
                                navigator.clipboard.writeText(
                                  `${s.ticker}\nכניסה: ${money(s.entry)}–${money(s.maxEntry)}\nסטופ: ${money(s.stop)}\nיעד: ${money(s.target)}\nכמות מחושבת: ${number(s.sizing.shares)}\nבתוקף עד ${time(s.expiresAt)}`,
                                ),
                              "התוכנית הועתקה",
                            )
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="panel empty">
                      <span className="empty-icon">⌁</span>
                      <h2>
                        {runtime.scanning
                          ? "מחפשים תנאים מתאימים"
                          : "אין כרגע איתותים בתוקף"}
                      </h2>
                      <p>
                        {!runtime.marketOpen
                          ? "המערכת תחזור לחפש אחרי פתיחת השוק. אין צורך להפעיל סריקה ידנית."
                          : diagnostics.evaluatedCount === 0 && diagnostics.selectedCount > 0
                            ? "המועמדות נבחרו, אך חסר מידע יומי או תוך־יומי מלא לאישור. אין שימוש בנתון ישן כדי לייצר איתות."
                            : diagnostics.selectedCount === 0
                              ? "אין כרגע מועמדות שעברו את הסינון והאסטרטגיות הפעילות."
                              : "המועמדות נבדקו; תנאי הכניסה או מגבלות הסיכון לא התקיימו. כשיתקיימו, האיתות יופיע אוטומטית."}
                      </p>
                      <span className="subtle">
                        מתחילים לבדוק איתותים לאחר בניית טווח הפתיחה.
                      </span>
                    </div>
                  )}
                  <details className="watch-panel" open>
                    <summary>מניות במעקב — עדיין אין איתות כניסה</summary>
                    {candidates.length ? (
                      <div className="watch-grid">
                        {candidates.map((candidate) => (
                          <WatchCard
                            key={`${candidate.ticker}:${candidate.strategy}`}
                            candidate={candidate}
                            label={strategy(candidate.strategy)?.label}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="panel empty compact">
                        <h2>
                          {universeStatus.running || runtime.scanning
                            ? "מכינים היסטוריה וסורקים מועמדות"
                            : runtime.error
                              ? "נתוני השוק אינם זמינים כרגע"
                              : "לא נמצאו תנאים מתאימים למעקב"}
                        </h2>
                        <p>
                          כרטיסי מעקב יופיעו רק למניות שעברו סינון בסיסי ומחכות
                          לטריגר כניסה או לנפח יחסי גבוה יותר.
                        </p>
                      </div>
                    )}
                  </details>
                  <details className="diagnostics">
                    <summary>מה נבדק בסריקה האחרונה?</summary>
                    <p>
                      {runtime.diagnostics
                        ? `${number(diagnostics.universeSize)} מניות במאגר · ${number(diagnostics.selectedCount)} נבחרו לבדיקה עמוקה · ${number(diagnostics.evaluatedCount)} נבדקו · ${number(runtime.personalDiagnostics?.newSignals)} איתותים חדשים בפרופיל שלך`
                        : "עדיין לא הושלמה סריקה."}
                    </p>
                    {runtime.diagnostics?.sipContext && (
                      <p>
                        SIP מושהה: {runtime.diagnostics.sipContext.mode === "shadow" ? "מצב בדיקה בלבד — אינו איתות" : runtime.diagnostics.sipContext.mode === "enabled" ? "פעיל עם סימון מקור מושהה" : "כבוי"}
                        {` · ${number(runtime.diagnostics.sipContext.selected)} מועמדות · ${number(runtime.diagnostics.sipContext.shadowDecisions)} החלטות shadow`}
                      </p>
                    )}
                    <p>
                      היסטוריה יומית מכלל הבורסות דרך SIP; נתונים חיים, נרות
                      וטריגרים תוך־יומיים מבורסת IEX. SIP מושהה, אם זמין, משמש
                      רק להקשר נפח ואינו מחיר חי. המחיר עשוי להיות שונה ממחיר הביצוע.
                    </p>
                    <p>
                      {selectionStatus.listSizes
                        ? `פיזור בחירה: ORB ${number(selectionStatus.listSizes.orb15)} · ORB Retest ${number(selectionStatus.listSizes.orb15_retest)} · Gap ${number(selectionStatus.listSizes.gap_pullback)} · VWAP ${number(selectionStatus.listSizes.vwap_reclaim)} · VWAP Pullback ${number(selectionStatus.listSizes.vwap_pullback)} · Bull Flag ${number(selectionStatus.listSizes.momentum_bull_flag)} · Reversal ${number(selectionStatus.listSizes.reversal5)}`
                        : ""}
                    </p>
                  </details>
                  <div className="bottom-grid">
                    <section className="panel">
                      <div className="section-heading">
                        <h2>עדכונים אחרונים</h2>
                        <span className="subtle">
                          {data.pushDevices
                            ? "התראות מחוברות"
                            : "התראות טרם חוברו"}
                        </span>
                      </div>
                      {data.events.slice(0, 4).map((e) => (
                        <div className="event" key={e.id}>
                          <span className="event-icon">
                            {e.type === "exit" ? "↗" : "·"}
                          </span>
                          <div>
                            <b>{e.title}</b>
                            <p>{e.body}</p>
                            <small>{time(e.createdAt)}</small>
                          </div>
                        </div>
                      ))}
                      {!data.events.length && (
                        <p className="muted">עדכוני סריקה ומעקב ייאספו כאן.</p>
                      )}
                    </section>
                    <section className="panel notification-panel">
                      <span className="empty-icon small">♧</span>
                      <h2>העדכון הבא יגיע אליך</h2>
                      <p>
                        קבל התראות על איתותים ועל הגעה לסטופ, ליעד או למועד
                        יציאה. ההתראה לא מבצעת עסקה.
                      </p>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          act(enablePush, "ההתראות חוברו ונשלחה התראת בדיקה")
                        }
                      >
                        חיבור התראות למכשיר
                      </button>
                    </section>
                  </div>
                </>
              )}
              {tab === "trades" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">חשיפה נוכחית</span>
                      <h1>עסקאות פתוחות</h1>
                      <p>
                        לפי הדיווח שלך. המערכת עדיין אינה מחוברת לחשבון הברוקר,
                        ולכן אין סגירה אוטומטית של עסקאות.
                      </p>
                    </div>
                  </div>
                  <div className="panel open-summary">
                    <div>
                      <span>עסקאות פתוחות</span>
                      <strong>{open.length}</strong>
                    </div>
                    <div>
                      <span>רווח/הפסד לא ממומש</span>
                      {(() => {
                        const priced = open.filter((t) => Number.isFinite(Number(t.lastPrice)) && Number.isFinite(Number(t.entry)) && Number.isFinite(Number(t.shares)));
                        if (!open.length) return <strong>—</strong>;
                        if (priced.length !== open.length) return <strong>לא זמין</strong>;
                        const total = priced.reduce((sum, t) => sum + (Number(t.lastPrice) - Number(t.entry)) * Number(t.shares), 0);
                        return <strong className={total >= 0 ? "pl-up" : "pl-down"} dir="ltr">{money(total)}</strong>;
                      })()}
                    </div>
                    <div>
                      <span>סגירה דרך MT4</span>
                      <strong>לא זמין</strong>
                    </div>
                  </div>
                  <div className="panel mt4-positions">
                    <div className="section-heading">
                      <h2>פוזיציות פתוחות ב-MT4 (דמו)</h2>
                      <span className="badge">
                        {mt4Positions?.fresh ? "מתעדכן" : "אין דיווח עדכני"}
                      </span>
                    </div>
                    {mt4Positions?.fresh && mt4Positions.positions?.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>סימול</th>
                            <th>כיוון</th>
                            <th>כמות</th>
                            <th>כניסה</th>
                            <th>מחיר נוכחי</th>
                            <th>סטופ / יעד</th>
                            <th>רווח/הפסד</th>
                            <th>פעולה</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mt4Positions.positions.map((p) => (
                            <tr key={p.ticket}>
                              <td dir="ltr">{p.symbol}</td>
                              <td>{p.side === "buy" ? "קנייה" : "מכירה"}</td>
                              <td>{p.lots}</td>
                              <td dir="ltr">{p.openPrice}</td>
                              <td dir="ltr">{p.currentPrice ?? "לא זמין"}</td>
                              <td dir="ltr">{`${p.stopLoss ?? "—"} / ${p.takeProfit ?? "—"}`}</td>
                              <td dir="ltr" className={p.profit >= 0 ? "pl-up" : "pl-down"}>{p.profit ?? "לא זמין"}</td>
                              <td>
                                <button
                                  className="danger close-btn"
                                  disabled={busy || closeRequests.some((r) => r.ticket === p.ticket && ["pending", "claimed", "unknown"].includes(r.status))}
                                  onClick={() => closePosition(p)}
                                >
                                  {closeRequests.some((r) => r.ticket === p.ticket && ["pending", "claimed"].includes(r.status)) ? "נסגרת…" : "סגור פוזיציה"}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : mt4Positions?.fresh ? (
                      <p>אין פוזיציות פתוחות ב-MT4 כרגע.</p>
                    ) : (
                      <p>
                        אין דיווח עדכני מ-MT4. הפוזיציות מוצגות רק כשה-EA מחובר
                        ושולח נתונים. סגירת עסקה מהדשבורד עדיין אינה זמינה.
                      </p>
                    )}
                  </div>
                  {closeRequests.length > 0 && (
                    <div className="panel close-requests">
                      <div className="section-heading"><h2>בקשות סגירה אחרונות</h2></div>
                      {closeRequests.slice(0, 5).map((r) => (
                        <div className="order-row" key={r.id}>
                          <b dir="ltr">{r.symbol}</b>
                          <span>
                            {{ pending: "ממתינה ל־EA", claimed: "ה־EA מטפל", closed: "נסגרה", rejected: "נדחתה", expired: "פג תוקף", unknown: "מצב לא ברור, בדוק ב־MT4" }[r.status] || r.status}
                            {r.closePrice != null ? ` · מחיר סגירה ${r.closePrice}` : ""}
                          </span>
                          <small dir="ltr">{r.error || time(r.updatedAt)}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  {open.length ? (
                    open.map((t) => (
                      <div className="panel trade" key={t.id}>
                        <div className="section-heading">
                          <h2 dir="ltr">{t.ticker}</h2>
                          <span className="badge">
                            {strategy(t.strategy)?.label}
                          </span>
                        </div>
                        {t.exitAlert && (
                          <div className="banner warning">
                            התקבל סימן יציאה: {names[t.exitAlert]}. בדוק את
                            העסקה אצל הברוקר; לא בוצעה מכירה.
                          </div>
                        )}
                        <div className="trade-values">
                          <Metric
                            label="מחיר הכניסה שלך"
                            value={money(t.entry)}
                            sub={`${number(t.shares)} מניות`}
                          />
                          <Metric
                            label="מחיר שנצפה"
                            value={money(t.lastPrice)}
                            sub={time(t.priceAt)}
                          />
                          <Metric
                            label="רווח/הפסד לא ממומש"
                            value={
                              Number.isFinite(Number(t.lastPrice)) && Number.isFinite(Number(t.entry)) && Number.isFinite(Number(t.shares))
                                ? money((Number(t.lastPrice) - Number(t.entry)) * Number(t.shares))
                                : "לא זמין"
                            }
                            sub="לפי מחיר שנצפה"
                          />
                          <Metric
                            label="סטופ / יעד"
                            value={`${money(t.stop)} / ${money(t.target)}`}
                            sub={`מועד יציאה: ${time(t.deadline)}`}
                          />
                        </div>
                        <button
                          className="primary"
                          onClick={() => setModal({ kind: "close", trade: t })}
                        >
                          דיווח על מכירה
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="panel empty">
                      <span className="empty-icon">↗</span>
                      <h2>אין עסקאות פתוחות כרגע</h2>
                      <p>
                        אחרי ביצוע עסקה אצל הברוקר, לחץ על ״דיווח על קנייה״
                        בכרטיס האיתות והזן את המחיר, הכמות וזמן הביצוע.
                      </p>
                      <button
                        className="secondary"
                        onClick={() => setTab("today")}
                      >
                        להזדמנויות היום
                      </button>
                    </div>
                  )}
                  <details className="diagnostics">
                    <summary>
                      החזקות מהמערכת הקודמת ({legacy?.holdings?.length || 0})
                    </summary>
                    <p>
                      המידע המקורי נשמר. להחזקות אלו לא הוגדרה תוכנית מעקב
                      אוטומטית חדשה.
                    </p>
                    {legacy?.holdings?.map((h, i) => (
                      <div className="archive-row" key={h.id || i}>
                        <b>{h.ticker}</b>
                        <span>
                          {number(h.quantity)} מניות · מחיר קנייה{" "}
                          {money(h.averageBuyPrice)}
                        </span>
                      </div>
                    ))}
                    {legacy?.watchlist?.length > 0 && (
                      <p>
                        רשימת המעקב הקודמת:{" "}
                        {legacy.watchlist.map((h) => h.ticker).join(", ")}
                      </p>
                    )}
                  </details>
                  <h2 className="spaced">עסקאות שדיווחת שנסגרו</h2>
                  <History
                    rows={data.trades.filter(
                      (t) => t.source === "personal" && t.status === "closed",
                    )}
                  />
                  <details className="diagnostics">
                    <summary>דיווח על קנייה מאיתות שכבר פג</summary>
                    <p>
                      לרישום עסקה שכבר ביצעת בלבד. האיתות אינו תקף לכניסה חדשה.
                    </p>
                    {data.signals
                      .filter((s) => s.status !== "active")
                      .slice(0, 20)
                      .map((s) => (
                        <div className="archive-row" key={s.id}>
                          <span>
                            {s.ticker} · {time(s.createdAt)} ·{" "}
                            {strategy(s.strategy)?.label}
                          </span>
                          <button
                            onClick={() =>
                              setModal({ kind: "entry", signal: s })
                            }
                          >
                            דיווח קנייה
                          </button>
                        </div>
                      ))}
                  </details>
                </>
              )}
              {tab === "results" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">לומדים מהתוצאות</span>
                      <h1>תוצאות ומעקב</h1>
                      <p>
                        סימולציה ועסקאות אישיות מוצגות בנפרד. המדידה ממשיכה גם
                        כשאתה לא כאן.
                      </p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() =>
                        act(async () => {
                          const out = await api("/export");
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(out, null, 2)], {
                              type: "application/json",
                            }),
                          );
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = "tradesense-history.json";
                          a.click();
                          URL.revokeObjectURL(url);
                        }, "ההיסטוריה יוצאה")
                      }
                    >
                      ייצוא היסטוריה
                    </button>
                  </div>
                  <div className="bottom-grid">
                    {data.stats.map((s) => (
                      <section className="panel" key={s.source}>
                        <span className="eyebrow">
                          {s.source === "simulation"
                            ? "סימולציה אוטומטית"
                            : "עסקאות אישיות מדווחות"}
                        </span>
                        <h2 className="stat-large">{money(s.pnl)}</h2>
                        <p>
                          {s.n} עסקאות סגורות ·{" "}
                          {s.winRate == null
                            ? "אין עדיין שיעור הצלחה"
                            : `${s.winRate.toFixed(1)}% רווחיות`}
                        </p>
                        <small>
                          לפני מס והמרת מט״ח.{" "}
                          {s.source === "simulation"
                            ? "הביצוע מדומה ואינו תשואת החשבון."
                            : ""}
                        </small>
                      </section>
                    ))}
                  </div>
                  <h2 className="spaced">מעקב המלצות שלא תלוי בקנייה</h2>
                  <div className="metrics">
                    <Metric
                      label="המלצות שנשמרו"
                      value={number(data.recommendationSummary?.published)}
                      sub="כולל כאלה שלא נקנו"
                    />
                    <Metric
                      label="בדיקות שהושלמו"
                      value={number(data.recommendationSummary?.complete)}
                      sub="לפי מודל 5 דקות שמרני"
                    />
                    <Metric
                      label="ללא כניסה נצפית"
                      value={number(data.recommendationSummary?.noObservedFill)}
                      sub="לא נחשב כהפסד או רווח"
                    />
                  </div>
                  <div className="panel compact-report">
                    <h2>איכות מדידה לפי אופקים</h2>
                    <p>
                      המדידה מפרידה בין תוצאת התוכנית, תנועת המניה וראיות quote.
                      נתוני SIP/quotes הם בדיעבד ואינם מוכיחים ביצוע בפועל.
                    </p>
                    <div className="quality-chips">
                      {(data.recommendationQuality?.rows || []).slice(0, 12).map((row) => (
                        <span className="badge" key={`${row.horizon}:${row.strategy}:${row.strategyVersion}`}>
                          {row.horizon} · {row.strategy}: {number(row.complete)}/{number(row.publishedUniqueSetups)} complete
                        </span>
                      ))}
                      {!(data.recommendationQuality?.rows || []).length && (
                        <span className="subtle">עדיין אין אופקים שהושלמו.</span>
                      )}
                    </div>
                  </div>
                  <FeedbackStatusPanel status={data.recommendationFeedback} />
                  <RecommendationHistory rows={data.recommendations || []} />
                  {data.recommendationNextCursor && (
                    <div className="card-actions">
                      <button className="secondary" disabled={busy} onClick={loadMoreRecommendations}>
                        טען המלצות נוספות
                      </button>
                    </div>
                  )}
                  <h2 className="spaced">ארבע שיטות, חוקים שקופים</h2>
                  <div className="strategy-grid">
                    {data.strategies.map((s) => (
                      <section className="panel" key={s.key}>
                        <div className="section-heading">
                          <h3>{s.label}</h3>
                          <span className="badge amber">גרסה בבדיקה</span>
                        </div>
                        <p>{s.description}</p>
                        <small>
                          {s.mode === "day"
                            ? "יציאה תוך־יומית"
                            : "עד 5 ימי מסחר"}{" "}
                          ·{" "}
                          {s.risk === "aggressive"
                            ? "סיכון גבוה"
                            : "סיכון בינוני"}{" "}
                          · גרסה {s.version}
                        </small>
                        <a
                          className="source"
                          href={s.source}
                          target="_blank"
                          rel="noreferrer"
                        >
                          מקור השיטה ↗
                        </a>
                      </section>
                    ))}
                  </div>
                  <h2 className="spaced">סימולציות אחרונות</h2>
                  <History
                    rows={data.trades.filter((t) => t.source === "simulation")}
                  />
                  <p className="muted">
                    תוצאות v2 הישנות לא הועברו לגרסאות החדשות. סימולציה לפי
                     מחירי IEX אינה מבטיחה מחיר ביצוע אצל הברוקר.
                  </p>
                </>
              )}
              {tab === "settings" && (
                <Settings
                  key={settings.setupComplete ? "saved" : "new"}
                  settings={settings}
                  strategies={data.strategies}
                  busy={busy}
                  onSave={(value) =>
                    act(
                      () =>
                        api("/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            ...value,
                            setupComplete: true,
                          }),
                        }),
                      "ההגדרות נשמרו",
                    )
                  }
                  onPush={() => act(enablePush, "ההתראות חוברו ונשלחה בדיקה")}
                />
              )}
              {tab === "activity" && <ActivityLog events={data.events || []} />}
              <footer>
                TradeSense · המלצות ומעקב, ללא ביצוע פקודות · לא תחליף לייעוץ
                השקעות · נתוני שוק בכיסוי חלקי
              </footer>
            </>
          )}
        </main>
      </div>
      {modal && (
        <TradeDialog
          modal={modal}
          error={error}
          busy={busy}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            const ok = await act(
              () =>
                api(
                  modal.kind === "entry"
                    ? `/signals/${encodeURIComponent(modal.signal.id)}/entry`
                    : `/trades/${encodeURIComponent(modal.trade.id)}/close`,
                  { method: "POST", body: JSON.stringify(values) },
                ),
              modal.kind === "entry"
                ? "הקנייה שדיווחת נוספה למעקב"
                : "המכירה שדיווחת נשמרה",
            );
            if (ok) setModal(null);
          }}
        />
      )}
    </div>
  );
}

function StatusRibbon({ data, executionState, mt4Positions }) {
  if (!data) return null;
  const runtime = data.runtime || {};
  const executionMode = executionState?.mode || "off";
  const scanner = data.systemPaused ? "מושהה" : runtime.healthy ? "פעיל" : "לא זמין";
  const scannerTone = data.systemPaused ? "warn" : runtime.healthy ? "ok" : "muted";
  const bot = executionMode === "autonomous" ? "פעיל" : executionMode === "scanner" ? "סורק בלבד" : executionMode === "error" ? "שגיאה" : "כבוי";
  const botTone = executionMode === "autonomous" ? "warn" : executionMode === "error" ? "error" : "muted";
  const mt4 = executionState?.agentConnected ? "מחובר" : executionState ? "ממתין" : "לא ידוע";
  const mt4Tone = executionState?.agentConnected ? "ok" : "warn";
  const mt4Fresh = Boolean(mt4Positions?.fresh);
  return (
    <section className="status-ribbon" aria-label="תמונת מצב של המערכת">
      <div className="status-ribbon-intro">
        <span className="eyebrow">תמונת מצב</span>
        <strong>סביבת דמו בלבד</strong>
        <small>הביצוע נשאר מוגבל עד לאימות חיבור מלא.</small>
      </div>
      <StatusRibbonItem label="סורק" value={scanner} tone={scannerTone} />
      <StatusRibbonItem label="בוט" value={bot} tone={botTone} />
      <StatusRibbonItem label="חיבור MT4" value={mt4} tone={mt4Tone} />
      <StatusRibbonItem
        label="יתרת חשבון"
        value={mt4Fresh && Number.isFinite(mt4Positions.balance) ? `${mt4Positions.balance.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ${mt4Positions.currency || ""}` : "לא זמין"}
        note={mt4Fresh ? "MT4 דמו, בזמן אמת" : "אין דיווח עדכני מ-MT4"}
        tone={mt4Fresh ? "ok" : "muted"}
      />
      <StatusRibbonItem
        label="רווח/הפסד פתוח"
        value={mt4Fresh && Number.isFinite(mt4Positions.profit) ? mt4Positions.profit.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : "לא זמין"}
        note={mt4Fresh ? "לא ממומש, מ-MT4" : "אין דיווח עדכני מ-MT4"}
        tone={mt4Fresh ? (mt4Positions.profit >= 0 ? "ok" : "error") : "muted"}
      />
    </section>
  );
}

function StatusRibbonItem({ label, value, note, tone = "muted" }) {
  return (
    <div className={`status-ribbon-item ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note || "מצב בזמן אמת"}</small>
    </div>
  );
}

function ActivityLog({ events }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">מעקב שקוף</span>
          <h1>יומן פעילות</h1>
          <p>אירועי המערכת שנקלטו מהשרת. אין כאן נתוני חשבון שלא דווחו בפועל.</p>
        </div>
        <span className="demo-badge">חשבון דמו בלבד</span>
      </div>
      <section className="panel activity-panel">
        <div className="section-heading">
          <h2>אירועים אחרונים</h2>
          <span className="subtle">{events.length} אירועים זמינים</span>
        </div>
        {events.length ? (
          <div className="activity-list">
            {events.map((event) => (
              <article className="activity-row" key={event.id || `${event.createdAt}-${event.title}`}>
                <span className={`activity-dot ${event.type === "exit" ? "green" : ""}`} />
                <div>
                  <strong>{event.title || "אירוע מערכת"}</strong>
                  <p>{event.body || "אין פירוט נוסף"}</p>
                </div>
                <time dateTime={event.createdAt}>{time(event.createdAt)}</time>
              </article>
            ))}
          </div>
        ) : (
          <div className="activity-empty"><span className="empty-icon small">≋</span><p>עדיין לא נרשמו אירועים.</p></div>
        )}
      </section>
    </>
  );
}

function ControlTerminal({ data, executionOrders, executionState, mt4Positions, busy, onStart, onStop, onSettings, onAutonomousStart, onAutonomousStop, onEmergencyStop }) {
  const settings = data?.settings || {};
  const runtime = data?.runtime || {};
  const openTrades = (data?.trades || []).filter((trade) => trade.source === "personal" && trade.status === "open");
  const history = (data?.trades || []).filter((trade) => trade.source === "personal" && trade.status === "closed");
  const state = data?.systemPaused ? "מושהה" : runtime.healthy ? "פעיל" : "ממתין לחיבור";
  const executionMode = executionState?.mode || "off";
  const mt4Fresh = Boolean(mt4Positions?.fresh);
  const dayResult = mt4Fresh && Number.isFinite(mt4Positions.closedToday) ? mt4Positions.closedToday + (Number.isFinite(mt4Positions.profit) ? mt4Positions.profit : 0) : null;
  const baseEquity = mt4Fresh && Number.isFinite(mt4Positions.balance) ? mt4Positions.balance : Number(settings.equity);
  const lossLimit = Number.isFinite(baseEquity) && Number.isFinite(Number(settings.dailyLossPct)) ? -(baseEquity * Number(settings.dailyLossPct)) / 100 : null;
  const mt4Open = mt4Fresh ? mt4Positions.positions.length : null;
  const readiness = [
    { ok: Boolean(executionState?.agentConnected), label: "MT4 מחובר ומזוהה כחשבון דמו" },
    { ok: executionState?.autonomyEnabled === true, label: "השרת מאשר מסחר עצמאי (EXECUTION_AUTONOMY_ENABLED)", blocking: "דגל בטיחות בשרת. משנים אותו רק בהחלטה מפורשת שלך, לא מהדשבורד" },
    { ok: executionState?.queueEnabled === true, label: "תור הביצוע פעיל בשרת (EXECUTION_QUEUE_ENABLED)", blocking: "דגל בטיחות בשרת. משנים אותו רק בהחלטה מפורשת שלך, לא מהדשבורד" },
    { ok: mt4Fresh, label: "נתוני חשבון עדכניים מ־MT4" },
    { ok: !data?.systemPaused && Boolean(runtime.healthy), label: "מנוע האיתותים פעיל", soft: true },
  ];
  const canStartAutonomous = readiness.filter((r) => !r.soft).every((r) => r.ok);
  const money2 = (v) => (Number.isFinite(v) ? v.toLocaleString("he-IL", { maximumFractionDigits: 2 }) : "—");
  const executionLabel = executionMode === "autonomous" ? "מסחר עצמאי פעיל" : executionMode === "scanner" ? "סורק בלבד" : executionMode === "error" ? "עצירה עקב שגיאה" : executionState ? "כבוי" : "ממתין לחיבור שרת";
  return (
    <>
      <div className="terminal-hero">
        <div>
          <span className="eyebrow">מרכז שליטה · סביבת הדגמה</span>
          <h1>מערכת המסחר שלך</h1>
          <p>מקום אחד למצב המערכת, להגדרות ולאיתותים. ביצוע פקודות עדיין בבנייה.</p>
        </div>
        <span className="demo-badge">חשבון דמו בלבד</span>
      </div>
      <div className="connection-banner">
        <span className="status-led" />
        <div>
          <strong>חיבור MT4: {executionState?.agentConnected ? "מחובר לחשבון דמו" : "ממתין לחיבור"}</strong>
          <span>{executionState?.agentConnected ? "ה־EA דיווח לאחרונה והחשבון זוהה כדמו." : "הפעלת מסחר עצמאי תחסם עד שנקבל heartbeat מאומת מה־EA."}</span>
        </div>
        <span className="badge amber">בבנייה</span>
      </div>
      <div className="terminal-metrics">
        <section className="terminal-metric"><span>מצב המערכת</span><strong>{state}</strong><small>{data?.systemPaused ? "סריקות מושהות" : "מנוע האיתותים"}</small></section>
        <section className="terminal-metric"><span>יתרת חשבון</span><strong dir="ltr">{mt4Fresh ? `${money2(mt4Positions.balance)} ${mt4Positions.currency || ""}` : "—"}</strong><small>{mt4Fresh ? "MT4 דמו, בזמן אמת" : "אין דיווח עדכני מ־MT4"}</small></section>
        <section className="terminal-metric"><span>רווח / הפסד היום</span><strong dir="ltr" className={dayResult != null ? (dayResult >= 0 ? "pl-up" : "pl-down") : ""}>{dayResult != null ? money2(dayResult) : "—"}</strong><small>{dayResult != null ? "סגורות היום + פתוחות" : "אין נתון מ־MT4"}</small></section>
        <section className="terminal-metric"><span>פוזיציות פתוחות</span><strong>{mt4Open != null ? mt4Open : openTrades.length}</strong><small>{mt4Open != null ? "לפי MT4" : "דיווחים ידניים במעקב"}</small></section>
      </div>
      <div className="terminal-grid">
        <section className="panel control-panel">
          <div className="section-heading"><h2>בקרת מסחר עצמאי</h2><span className={executionMode === "autonomous" ? "badge live-badge" : "badge amber"}>{executionLabel}</span></div>
          <p>הסריקה וההרשאה לשליחת פקודות מופרדות. עצירה מונעת פקודות חדשות; היא אינה טוענת שבוצעה סגירה אצל הברוקר.</p>
          <div className="control-actions">
            <button className="primary" disabled={busy || executionMode === "autonomous" || !canStartAutonomous} onClick={onAutonomousStart}>הפעל מסחר עצמאי</button>
            <button className="secondary" disabled={busy || executionMode !== "autonomous"} onClick={onAutonomousStop}>עצור מסחר עצמאי</button>
            <button className="secondary" disabled={busy || executionMode === "scanner"} onClick={onStart}>הפעל סריקה בלבד</button>
            <button className="danger" disabled={busy || executionMode === "off"} onClick={onEmergencyStop}>עצירת חירום</button>
          </div>
          <div className="readiness-list">
            <strong>תנאים להפעלה</strong>
            {readiness.map((r) => (
              <div key={r.label} className={r.ok ? "ready-ok" : r.soft ? "ready-warn" : "ready-block"}>
                <span>{r.ok ? "✓" : r.soft ? "!" : "✗"}</span> {r.label}
                {!r.ok && r.blocking ? <small> · {r.blocking}</small> : null}
              </div>
            ))}
          </div>
          <div className="limits-list">
            <strong>מגבלות פעילות</strong>
            <div>פוזיציות: {mt4Open != null ? mt4Open : openTrades.length} מתוך {settings.maxPositions ?? "—"}</div>
            <div>הפסד יומי: {dayResult != null ? money2(dayResult) : "אין נתון"} · עצירה ב־{lossLimit != null ? money2(lossLimit) : "—"}</div>
            <div>סיכון לעסקה: {settings.riskPct ?? "—"}% · Stop Loss חובה בכל פקודה</div>
          </div>
          <div className="control-note"><span>◉</span> מצב נוכחי: {executionLabel}. {executionState?.reason || "השרת לא החזיר מצב ביצוע."}</div>
        </section>
        <section className="panel terminal-settings-card">
          <div className="section-heading"><h2>הגדרות מסחר</h2><button className="text-button" onClick={onSettings}>עריכה מלאה ←</button></div>
          <div className="settings-summary">
            <div><span>סגנון</span><b>{settings.risk === "aggressive" ? "אגרסיבי" : "סולידי"}</b></div>
            <div><span>סיכון לעסקה</span><b>{settings.riskPct ?? "—"}%</b></div>
            <div><span>הפסד יומי מרבי</span><b>{settings.dailyLossPct ?? "—"}%</b></div>
            <div><span>פוזיציות מרביות</span><b>{settings.maxPositions ?? "—"}</b></div>
          </div>
          <p className="muted">Stop Loss: לפי תוכנית האיתות. אין כרגע הגדרה כללית שמחוברת לביצוע.</p>
        </section>
      </div>
      <div className="terminal-grid lower">
        <section className="panel">
          <div className="section-heading"><h2>פקודות ממתינות</h2><span className="badge">{executionOrders ? executionOrders.length : "—"}</span></div>
          {executionOrders?.length ? <div className="order-list">{executionOrders.map((order) => <div className="order-row" key={order.id}><b dir="ltr">{order.symbol}</b><span>{order.side === "buy" ? "קנייה" : "מכירה"} · {order.quantity}</span><small>{order.status}</small></div>)}</div> : <p className="muted">{executionOrders === null ? "תור הביצוע אינו מחובר לממשק עדיין." : "אין פקודות ממתינות."}</p>}
        </section>
        <section className="panel">
          <div className="section-heading"><h2>איתותים אחרונים</h2><button className="text-button" onClick={onSettings}>ניהול אסטרטגיות ←</button></div>
          {(data?.signals || []).slice(0, 4).length ? <div className="signal-mini-list">{(data?.signals || []).slice(0, 4).map((signal) => <div className="signal-mini" key={signal.id}><b dir="ltr">{signal.ticker}</b><span>{signal.direction === "short" ? "מכירה" : "קנייה"}</span><small>{signal.status === "active" ? "בתוקף" : "פג"}</small></div>)}</div> : <p className="muted">אין איתותים זמינים כרגע.</p>}
        </section>
      </div>
      <section className="panel terminal-history">
        <div className="section-heading"><h2>עסקאות והיסטוריה</h2><span className="subtle">מעקב ידני בלבד עד חיבור MT4</span></div>
        {openTrades.length || history.length ? <div className="history-chips"><span className="badge">פתוחות: {openTrades.length}</span><span className="badge">היסטוריה: {history.length}</span></div> : <p className="muted">עדיין אין עסקאות במעקב. לא יוצגו נתוני חשבון מומצאים.</p>}
      </section>
    </>
  );
}

function FeedbackStatusPanel({ status }) {
  const policy = status?.activePolicy || {};
  const gate = status?.latestGateCheck;
  const dataset = status?.dataset;
  const gates = gate?.gates || {};
  return (
    <div className="panel compact-report">
      <div className="section-heading">
        <h2>מנגנון שיפור ההמלצות</h2>
        <span className={policy.state === "active_limited" ? "badge" : "badge amber"}>
          {policy.state === "active_limited" ? "פעיל מוגבל" : policy.state === "eligible_for_limited_activation" ? "מוכן להפעלה" : "shadow בלבד"}
        </span>
      </div>
      <p>
        המערכת מודדת את כל ההמלצות וה־shadow candidates בלי קשר לקנייה. אחרי 7 ימי מסחר, שינוי דירוג חי מופעל רק אם ה־gates של כיסוי ואיכות עברו, עם rollback.
      </p>
      <div className="quality-chips">
        <span className="badge">policy: {policy.policyVersion || "baseline-v3"}</span>
        <span className="badge">dataset: {dataset?.datasetVersion || "עדיין לא נבנה"}</span>
        <span className="badge">ימי מסחר: {number(gates.forwardSessions || 0)} / {number(gates.minForwardSessions || 7)}</span>
        <span className="badge">setups: {number(dataset?.counts?.publishedUniqueSetups || 0)}</span>
        <span className="badge">coverage complete: {number(dataset?.coverage?.complete || 0)}</span>
        <span className="badge">gate: {gate?.decision || "ממתין לנתונים"}</span>
      </div>
      <small>{status?.note}</small>
    </div>
  );
}
function Metric({ label, value, sub }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong dir="ltr">{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
function Signal({ s, label, onEntry, onCopy }) {
  return (
    <article className="panel signal">
      <div className="section-heading">
        <span className="badge">{s.mode === "day" ? "יומי" : "עד 5 ימים"}</span>
        <span className="badge amber">איתות ניסיוני</span>
        {s.provenance?.volumeContext === "sip_delayed" && <span className="badge amber">הקשר נפח SIP מושהה</span>}
      </div>
      <div className="signal-title">
        <h2 dir="ltr">{s.ticker}</h2>
        <span>{s.company}</span>
      </div>
      <h3>{label}</h3>
      <p className="reason">{s.reason}</p>
      <div className="entry-band">
        <span>טווח כניסה</span>
        <strong dir="ltr">
          {money(s.entry)} – {money(s.maxEntry)}
        </strong>
      </div>
      <div className="targets">
        <div>
          <span>סטופ</span>
          <b dir="ltr">{money(s.stop)}</b>
        </div>
        <div>
          <span>יעד</span>
          <b dir="ltr">{money(s.target)}</b>
        </div>
        <div>
          <span>כמות מחושבת</span>
          <b>{number(s.sizing.shares)}</b>
        </div>
      </div>
       <p className="cost">
         עלות משוערת: <b>{money(s.sizing.cost)}</b> · סיכון מחושב:{" "}
         <b>{money(s.sizing.riskUsd)}</b>
       </p>
      {!s.sizing.feasible && (
        <p className="banner warning">
           ההון שהוגדר אינו מאפשר עסקה מעשית בתוכנית זו.
        </p>
      )}
      <p className="expiry">
        בתוקף עד {time(s.expiresAt)} · מעל {money(s.maxEntry)} האיתות מתבטל
      </p>
      <details>
         <summary>לפני ביצוע העסקה</summary>
        <p>
           בדוק שהמניה זמינה אצל הברוקר שלך, כולל תמיכה בשברים ובפקודת הסטופ הרצויה.
           הנתונים כאן מ־IEX, ויכולים להיות שונים ממחיר הביצוע.
        </p>
        <p>
          יציאה מתוכננת: {time(s.deadline)}. סיכון מחושב אינו הפסד מרבי מובטח.
        </p>
      </details>
      <div className="card-actions">
        <button className="primary" onClick={onEntry}>
           דיווח על קנייה
        </button>
        <button className="secondary" onClick={onCopy}>
          העתק תוכנית
        </button>
      </div>
    </article>
  );
}
function WatchCard({ candidate, label }) {
  return (
    <article className="panel watch-card">
      <div className="section-heading">
        <span className="badge">במעקב</span>
        <span className="subtle">{label}</span>
      </div>
      <div className="signal-title">
        <h2 dir="ltr">{candidate.ticker}</h2>
        <span>{candidate.company}</span>
      </div>
      <p className="reason">{candidate.reasonText}</p>
      <div className="watch-meta">
        <span>נבדק ב־{time(candidate.observedAt)}</span>
        <span>היסטוריה SIP · חי IEX</span>
      </div>
    </article>
  );
}
function History({ rows }) {
  return rows.length ? (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>מניה</th>
            <th>כניסה</th>
            <th>כמות</th>
            <th>מצב</th>
            <th>רווח / הפסד</th>
            <th>מועד</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map((t) => (
            <tr key={t.id}>
              <td>
                <b>{t.ticker}</b>
              </td>
              <td dir="ltr">{money(t.entry)}</td>
              <td>{number(t.shares)}</td>
              <td>
                {t.status === "open" ? "במעקב" : names[t.exitReason] || "נסגרה"}
                {t.dataGap && (
                  <small className="table-note">פער בכיסוי הנתונים</small>
                )}
              </td>
              <td
                dir="ltr"
                className={t.pnl > 0 ? "positive" : t.pnl < 0 ? "negative" : ""}
              >
                {money(t.pnl)}
              </td>
              <td>{time(t.closedAt || t.enteredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="panel muted">
      עדיין אין עסקאות להצגה. אין נתוני הדגמה או תשואות מומצאות.
    </div>
  );
}
function RecommendationHistory({ rows }) {
  const outcomeText = (row) => {
    const outcome = row.evaluation?.outcomeStatus;
    const workflow = row.evaluation?.workflowStatus;
    if (workflow === "retryable_error") return "חסר כיסוי נתונים";
    if (workflow === "unresolved") return "לא פתיר";
    if (outcome === "target") return "יעד נצפה";
    if (outcome === "stop") return "סטופ נצפה";
    if (outcome === "time_exit") return "יציאה בזמן";
    if (outcome === "no_observed_fill") return "ללא כניסה נצפית";
    if (outcome === "ambiguous") return "לא חד־משמעי";
    if (outcome === "invalidated_before_entry") return "נפסלה לפני כניסה";
    const status = row.status;
    if (status === "expired") return "פגה";
    if (status === "invalidated") return "נפסלה לפני כניסה";
    return status === "active" ? "פעילה" : status || "נשמרה";
  };
  return rows.length ? (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>מניה</th>
            <th>אסטרטגיה</th>
            <th>פורסמה</th>
            <th>תוכנית מקורית</th>
            <th>סטטוס</th>
            <th>תוצאת בדיקה</th>
            <th>תיוג</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <b dir="ltr">{row.ticker}</b>
              </td>
              <td>{row.strategy}</td>
              <td>{time(row.publishedAt)}</td>
              <td dir="ltr">
                {money(row.plan?.entry)}–{money(row.plan?.maxEntry)} / {money(row.plan?.stop)} / {money(row.plan?.target)}
              </td>
              <td>{outcomeText(row)}</td>
              <td>
                {row.evaluation ? (
                  <>
                    <span>{row.evaluation.metrics?.netReturnPct == null ? "—" : `${row.evaluation.metrics.netReturnPct.toFixed(2)}%`}</span>
                    <small className="table-note">נבדק: {time(row.evaluation.checkedAt)}</small>
                    <small className="table-note">{row.evaluation.evaluatorVersion || "גרסת evaluator לא ידועה"}</small>
                  </>
                ) : (
                  <span className="subtle">ממתינה לבדיקה</span>
                )}
              </td>
              <td>
                {row.tags?.fast_momentum_candidate ? (
                  <span className="badge amber">מומנטום מהיר ניסיוני</span>
                ) : (
                  <span className="subtle">רגיל</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="panel muted">
      עדיין אין ארכיון המלצות חדש. המלצות חדשות יישמרו גם אם לא תקנה אותן.
    </div>
  );
}
function Settings({ settings, strategies, busy, onSave, onPush }) {
  const [form, setForm] = useState(settings);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">הגדרה אחת, מעקב מתמשך</span>
          <h1>מותאם לחשבון שלך</h1>
          <p>הסכומים מוזנים ידנית. עדכן אותם לאחר ביצוע או סגירת עסקה.</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
        className="settings-layout"
      >
        <section className="panel">
          <h2>החשבון שלך</h2>
          <div className="form-grid">
            <label>
              שווי החשבון בדולרים
              <input
                type="number"
                min="1"
                max="1000000"
                step="0.01"
                value={form.equity}
                onChange={(e) => set("equity", Number(e.target.value))}
                required
              />
            </label>
            <label>
              מזומן זמין לעסקאות חדשות
              <input
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                value={form.availableCash}
                onChange={(e) => set("availableCash", Number(e.target.value))}
                required
              />
            </label>
            <label>
              אופק העסקאות
              <select
                value={form.mode}
                onChange={(e) => set("mode", e.target.value)}
              >
                <option value="both">יומי וקצר</option>
                <option value="day">יומי בלבד</option>
                <option value="swing">עד 5 ימים בלבד</option>
              </select>
            </label>
            <label>
              סוג האיתותים
              <select
                value={form.risk}
                onChange={(e) => set("risk", e.target.value)}
              >
                <option value="balanced">סיכון בינוני</option>
                <option value="aggressive">בינוני וגבוה</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.fractional}
              onChange={(e) => set("fractional", e.target.checked)}
            />
            חשב גם שברי מניות — בכפוף לזמינות אצל הברוקר
          </label>
        </section>
        <section className="panel">
          <h2>גבולות הסימולציה והכמות</h2>
          <p className="muted">
            ערכי פתיחה שמרניים, ניתנים לשינוי. אלה הגדרות חישוב ולא הוראות
            לחשבון שלך.
          </p>
          <div className="form-grid">
            {[
              ["riskPct", "סיכון מחושב לעסקה (%)", 0.1, 2, 0.1],
              ["maxPositionPct", "תקרת הון לעסקה (%)", 1, 100, 1],
              ["maxPositions", "עסקאות סימולטיביות במקביל", 1, 10, 1],
              [
                "dailyLossPct",
                "עצירת כניסות בסימולציה בהפסד יומי (%)",
                0.5,
                10,
                0.5,
              ],
              ["slippagePct", "החלקת מחיר משוערת לכל צד (%)", 0, 2, 0.05],
            ].map(([key, label, min, max, step]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={form[key]}
                  onChange={(e) => set(key, Number(e.target.value))}
                  required
                />
              </label>
            ))}
          </div>
          <p className="muted">
            עצירת הסימולציה אינה סוגרת עסקה אצל הברוקר. הכמות האישית נשמרת לפי
            הביצוע שתדווח.
          </p>
        </section>
        <section className="panel">
          <h2>שיטות פעילות</h2>
          {strategies.map((s) => (
            <label className="check strategy-check" key={s.key}>
              <input
                type="checkbox"
                checked={form.strategies.includes(s.key)}
                onChange={(e) =>
                  set(
                    "strategies",
                    e.target.checked
                      ? [...form.strategies, s.key]
                      : form.strategies.filter((k) => k !== s.key),
                  )
                }
              />
              <span>
                <b>{s.label}</b>
                <small>
                  {s.mode === "day" ? "מסחר יומי" : "עד 5 ימים"} · גרסה בבדיקה
                </small>
              </span>
            </label>
          ))}
          <label>
            מניות שלא זמינות לך אצל הברוקר (מופרדות בפסיק)
            <input
              dir="ltr"
              placeholder="ABC, XYZ"
              defaultValue={form.excludedSymbols.join(", ")}
              onBlur={(e) =>
                set(
                  "excludedSymbols",
                  e.target.value
                    .toUpperCase()
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
        </section>
        <section className="panel">
          <h2>קבלת התראות</h2>
          <p>
            איתות חדש, הגעה לתנאי יציאה וסיכום יום. אין צורך להשאיר את הדף פתוח
            לאחר חיבור המכשיר.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onPush}
          >
            חיבור התראות ושליחת בדיקה
          </button>
          <p className="muted">
            נדרש HTTPS מחוץ למחשב המקומי. ב־iPhone יש לפתוח דרך קיצור שהוסף למסך
            הבית. מסירת התראה תלויה ברשת ובהרשאות המכשיר.
          </p>
        </section>
        <div className="save-bar">
          <span>ההגדרות נשמרות בשרת ומשמשות גם כשהדף סגור.</span>
          <button className="primary" disabled={busy}>
            שמירת הגדרות
          </button>
        </div>
      </form>
    </>
  );
}
function TradeDialog({ modal, error, busy, onClose, onSubmit }) {
  const ref = useRef(null);
  const requestId = useRef(globalThis.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    const digit = char === "x" ? value : (value & 0x3 | 0x8);
    return digit.toString(16);
  }));
  const [calculation, setCalculation] = useState({});
  const entry = modal.kind === "entry",
    item = entry ? modal.signal : modal.trade;
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      dir="rtl"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSubmit({
            price: Number(f.get("price")),
            ...(entry ? { requestId: requestId.current, trackingPlanMode: f.get("trackingPlanMode"), additionalLot: f.get("additionalLot") === "on" } : {}),
            ...(f.get("executedAt")
              ? { executedAt: new Date(f.get("executedAt")).toISOString() }
              : {}),
            ...(entry ? { shares: Number(f.get("shares")) } : {}),
          });
        }}
      >
        <div className="section-heading">
          <h2>
            {entry ? "דיווח על קנייה" : "דיווח על מכירה"} · {item.ticker}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="סגירה"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p>הזן את המחיר, הכמות וזמן הביצוע בפועל. הפעולה כאן שומרת דיווח בלבד.</p>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <label>
          מועד הביצוע (אופציונלי, לפי שעון המכשיר)
          <input type="datetime-local" name="executedAt" />
          <small>ריק = עכשיו. לדיווח מאוחר, הזן את המועד בפועל.</small>
        </label>
        <label>
          מחיר הביצוע בפועל ($)
          <input
            autoFocus
            type="number"
            name="price"
            min="0"
            step="any"
            required
            onChange={(e) => setCalculation((current) => ({ ...current, price: Number(e.target.value) }))}
          />
        </label>
        {entry && (
          <>
          <p className="muted">
            הכמות המוצעת: <b dir="ltr">{number(item.sizing?.shares)}</b> · זו הצעה בלבד; הזן את הכמות שקנית בפועל.
          </p>
          <p className="muted">לדוגמה: קנית 0.25 מניה במחיר $100 למניה? הכמות היא 0.25 והסכום הוא $25.</p>
          <label>
            כמות מניות בפועל · סכום העסקה מחושב כמחיר × כמות
            <input
              type="number"
              name="shares"
              min="0"
              step="any"
              required
              onChange={(e) => setCalculation((current) => ({ ...current, shares: Number(e.target.value) }))}
            />
          </label>
          <p className="muted" aria-live="polite">
            סכום העסקה המחושב: <b dir="ltr">{Number.isFinite(calculation.price * calculation.shares) && calculation.price > 0 && calculation.shares > 0 ? amount(calculation.price * calculation.shares) : "—"}</b>
          </p>
          <label>
            תוכנית מעקב
            <select name="trackingPlanMode" defaultValue={item.stop < item.entry && item.entry < item.target && (!item.deadline || Date.parse(item.deadline) > Date.now()) ? "signal" : "none"}>
              <option value="signal">איתות — התראות סטופ/יעד/מועד</option>
              <option value="none">מחיר בלבד — ללא התראות סטופ/יעד/מועד</option>
            </select>
          </label>
          <label>
            <input type="checkbox" name="additionalLot" />
            זו קנייה נוספת לאותו איתות — שמור כעסקה נפרדת
          </label>
          </>
        )}
        <div className="card-actions">
          <button className="primary" disabled={busy}>
            שמירת הדיווח
          </button>
          <button type="button" onClick={onClose}>
            ביטול
          </button>
        </div>
      </form>
    </dialog>
  );
}

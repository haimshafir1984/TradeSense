import { useEffect, useState } from 'react';
import PortfolioSection from './components/PortfolioSection';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

const exchangeOptions = [
  { value: 'NASDAQ', label: 'NASDAQ' },
  { value: 'NYSE', label: 'NYSE' }
];

// Mirrors server/src/risk/riskTiers.js's label/dailyLossCapPct (docs/SPEC_V2_ARCHITECTURE.md §5.5) -
// display-only duplication, same convention the old client used for strategy descriptions. The API
// response itself doesn't carry tier metadata, only per-candidate results.
const RISK_TIER_OPTIONS = [
  { value: 'conservative', label: 'שמרני', dailyLossCapPct: null, horizon: '20-60 יום' },
  { value: 'balanced', label: 'מאוזן', dailyLossCapPct: 3, horizon: '3-30 יום' },
  { value: 'aggressive', label: 'אגרסיבי', dailyLossCapPct: 2, horizon: 'תוך-יומי - 3 ימים' }
];

const STATUS_LABELS = {
  hypothesis: { text: 'רעיון בלבד - לא נבדק', tone: 'hypothesis' },
  backtested: { text: 'נבדק היסטורית - לא נמדד קדימה', tone: 'backtested' },
  provisional: { text: 'נמדד חלקית - גודל מוקטן', tone: 'provisional' },
  active: { text: 'נמדד', tone: 'active' }
};

const CATALYST_CONFIDENCE_LABELS = { high: 'ביטחון גבוה', medium: 'ביטחון בינוני', low: 'אזהרה - לא אומת' };

const BROKER_LINKS = [
  { id: 'ibi', label: 'IBI Trade', url: 'https://www.ibi.co.il/solutions/trading/' },
  { id: 'meitav', label: 'מיטב טרייד', url: 'https://www.meitav.co.il/trade/' },
  { id: 'interactive', label: 'Interactive Israel', url: 'https://www.inter-il.com/client-portal/' },
  { id: 'tradeon', label: 'TradeON', url: 'https://www.leumi.co.il/biz/Trade-On' },
  { id: 'atrade', label: 'ATRADE', url: 'https://www.atrade.co.il/' }
];

// Resolves "today's 9:30 ET market open" to the correct Israel wall-clock time, including the
// weeks when the US/Israel DST offset isn't the usual +7 (docs/SPEC_V2_ARCHITECTURE.md §13.0) -
// computed via Intl timezone conversion (self-correcting for DST) rather than a hardcoded offset.
function computeMarketOpenInIsrael() {
  const now = new Date();
  const nyDateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = nyDateParts.find((part) => part.type === 'year').value;
  const m = nyDateParts.find((part) => part.type === 'month').value;
  const d = nyDateParts.find((part) => part.type === 'day').value;

  // Guess 9:30 ET as UTC 13:30, then correct for whatever the actual NY offset is that day (EST/EDT).
  const guessUtc = new Date(`${y}-${m}-${d}T13:30:00Z`);
  const nyTimeParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(guessUtc);
  const nyHour = Number(nyTimeParts.find((part) => part.type === 'hour').value);
  const nyMinute = Number(nyTimeParts.find((part) => part.type === 'minute').value);
  const driftMinutes = 9 * 60 + 30 - (nyHour * 60 + nyMinute);

  return new Date(guessUtc.getTime() + driftMinutes * 60 * 1000);
}

function formatIsraelTime(date) {
  return new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatGeneratedAt(isoString) {
  try {
    return new Date(isoString).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function App() {
  const [activeTab, setActiveTab] = useState('candidates');
  const [exchange, setExchange] = useState('NASDAQ');
  const [riskTier, setRiskTier] = useState('balanced');
  const [accountRiskUsd, setAccountRiskUsd] = useState(() => {
    try {
      return window.localStorage.getItem('tradesense.accountRiskUsd') || '';
    } catch {
      return '';
    }
  });
  const [scanResult, setScanResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [expandedTicker, setExpandedTicker] = useState(null);
  const [openBrokerMenu, setOpenBrokerMenu] = useState(null);

  useEffect(() => {
    try {
      if (accountRiskUsd) {
        window.localStorage.setItem('tradesense.accountRiskUsd', accountRiskUsd);
      } else {
        window.localStorage.removeItem('tradesense.accountRiskUsd');
      }
    } catch {
      // localStorage unavailable - not critical, the field just won't persist across reloads.
    }
  }, [accountRiskUsd]);

  const selectedTier = RISK_TIER_OPTIONS.find((tier) => tier.value === riskTier) || RISK_TIER_OPTIONS[1];
  const marketOpenLabel = formatIsraelTime(computeMarketOpenInIsrael());

  async function runScan() {
    setIsLoading(true);
    setErrorMessage(null);
    setExpandedTicker(null);

    try {
      const params = new URLSearchParams({ exchange, riskTier });
      if (accountRiskUsd) {
        params.set('accountRiskUsd', accountRiskUsd);
      }
      const response = await fetch(`${API_BASE_URL}/api/candidates?${params.toString()}`);
      const data = await response.json();
      setScanResult(data);
    } catch (error) {
      setErrorMessage('שגיאת רשת - נסה שוב.');
    } finally {
      setIsLoading(false);
    }
  }

  const candidates = scanResult?.candidates || [];
  const regime = scanResult?.regime;

  return (
    <div className="page-shell" dir="rtl">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="topbar-brand">TradeSense</span>
          <nav className="topbar-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'candidates'}
              className={`topbar-tab ${activeTab === 'candidates' ? 'active' : ''}`}
              onClick={() => setActiveTab('candidates')}
            >
              סריקת מועמדים
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'portfolio'}
              className={`topbar-tab ${activeTab === 'portfolio' ? 'active' : ''}`}
              onClick={() => setActiveTab('portfolio')}
            >
              התיק שלי
            </button>
          </nav>
          <span className="topbar-open-time" title="שעת פתיחת השוק בשעון ישראל, כולל מעברי שעון">
            פתיחת מסחר היום: {marketOpenLabel}
          </span>
        </div>
      </header>

      <main className="layout">
        {activeTab === 'candidates' ? (
          <section className="candidates-section">
            <p className="v2-disclaimer">
              TradeSense מציגה לוגיקות מסחר מתועדות ואת מצב הנתונים מולן - <b>זו אינה המלצת השקעה או ייעוץ.</b> כל פלייבוק מסומן
              בדרגת אמינות (§5.8); ראו <a href="docs/SPEC_V2_ARCHITECTURE.md" target="_blank" rel="noreferrer">docs/SPEC_V2_ARCHITECTURE.md</a>.
            </p>

            <div className="controls-panel">
              <Field label="בורסה">
                <select value={exchange} onChange={(event) => setExchange(event.target.value)}>
                  {exchangeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="רמת סיכון">
                <select value={riskTier} onChange={(event) => setRiskTier(event.target.value)}>
                  {RISK_TIER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="סיכון בדולרים לעסקה (אופציונלי)">
                <input
                  type="number"
                  min="0"
                  placeholder="לדוגמה: 200"
                  value={accountRiskUsd}
                  onChange={(event) => setAccountRiskUsd(event.target.value)}
                />
              </Field>

              <button type="button" className="scan-button" onClick={runScan} disabled={isLoading}>
                {isLoading ? 'סורק...' : 'סרוק שוק'}
              </button>
            </div>

            <div className="tier-summary-bar">
              <span className="tier-summary-item">אופק: {selectedTier.horizon}</span>
              <span className="tier-summary-item">
                תקרת הפסד יומית: {selectedTier.dailyLossCapPct != null ? `${selectedTier.dailyLossCapPct}%` : 'ללא (אופק ארוך)'}
              </span>
              {regime ? (
                <span className={`regime-badge regime-${regime.state}`}>
                  משטר שוק: {regime.state === 'risk_on' ? 'תומך סיכון' : regime.state === 'risk_off' ? 'נגד סיכון' : 'ניטרלי'}
                </span>
              ) : null}
            </div>

            {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

            {scanResult ? (
              <p className="scan-meta">
                נוצר: {formatGeneratedAt(scanResult.generatedAt)} · {candidates.length} מועמדים
              </p>
            ) : null}

            {scanResult && scanResult.warnings?.length ? (
              <ul className="scan-warnings">
                {scanResult.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            {scanResult && candidates.length === 0 ? (
              <DiagnosticsPanel diagnostics={scanResult.diagnostics} />
            ) : null}

            <ol className="candidate-list">
              {candidates.map((candidate) => (
                <CandidateCard
                  key={`${candidate.ticker}-${candidate.playbook.key}`}
                  candidate={candidate}
                  isExpanded={expandedTicker === `${candidate.ticker}-${candidate.playbook.key}`}
                  onToggleExpand={() =>
                    setExpandedTicker((current) =>
                      current === `${candidate.ticker}-${candidate.playbook.key}` ? null : `${candidate.ticker}-${candidate.playbook.key}`
                    )
                  }
                  brokerMenuOpen={openBrokerMenu === candidate.ticker}
                  onToggleBrokerMenu={() => setOpenBrokerMenu((current) => (current === candidate.ticker ? null : candidate.ticker))}
                  onCloseBrokerMenu={() => setOpenBrokerMenu(null)}
                />
              ))}
            </ol>
          </section>
        ) : null}

        {activeTab === 'portfolio' ? <PortfolioSection apiBaseUrl={API_BASE_URL} /> : null}
      </main>
    </div>
  );
}

// Collapsed card answers only: what's the catalyst, what's the plan, which playbook and how
// trustworthy is it right now (docs/SPEC_V2_ARCHITECTURE.md §8's mandatory hierarchy). Everything
// else - factors, selection data - is behind the toggle.
function CandidateCard({ candidate, isExpanded, onToggleExpand, brokerMenuOpen, onToggleBrokerMenu, onCloseBrokerMenu }) {
  const statusInfo = STATUS_LABELS[candidate.playbook.status] || STATUS_LABELS.hypothesis;

  return (
    <li className={`candidate-card status-${statusInfo.tone}${isExpanded ? ' expanded' : ''}`}>
      <div className="candidate-card-main">
        <div className="candidate-identity">
          <span className="candidate-ticker">{candidate.ticker}</span>
          <span className="candidate-company">{candidate.companyName}</span>
          <span className="candidate-price">${candidate.price}</span>
        </div>

        <div className="candidate-catalyst">
          {candidate.catalyst ? (
            <>
              <span className={`catalyst-confidence catalyst-${candidate.catalyst.confidence}`}>
                {CATALYST_CONFIDENCE_LABELS[candidate.catalyst.confidence]}
              </span>
              <span className="catalyst-detail">{candidate.catalyst.detail}</span>
            </>
          ) : (
            <span className="catalyst-detail">לא זוהה קטליזטור</span>
          )}
        </div>

        <TradePlanSummary plan={candidate.plan} />

        <div className="candidate-playbook">
          <span className="playbook-label">{candidate.playbook.label}</span>
          <span className={`status-tag status-tag-${statusInfo.tone}`}>{statusInfo.text}</span>
        </div>

        <div className="candidate-actions">
          <button type="button" className="details-toggle" onClick={onToggleExpand} aria-expanded={isExpanded}>
            {isExpanded ? 'הסתר פירוט' : 'פירוט'}
          </button>
          <BrokerMenu isOpen={brokerMenuOpen} onToggle={onToggleBrokerMenu} onClose={onCloseBrokerMenu} />
        </div>
      </div>

      {isExpanded ? (
        <div className="candidate-details">
          <div className="candidate-details-block">
            <h4>גורמים</h4>
            <ul className="factor-list">
              {(candidate.factors || []).map((factor) => (
                <li key={factor.key}>
                  <span className="factor-label">{factor.label}</span>
                  <span className="factor-detail">{factor.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="candidate-details-block">
            <h4>נתוני בחירה</h4>
            <p className="cell-subtext">
              נפח יחסי: {candidate.selection?.rvol ?? '—'} ({candidate.selection?.rvolBasis === 'opening' ? 'פתיחה' : 'יומי'}) - מבוסס
              feed חלקי (iex, ~4% מנפח השוק), יחסי בין מניות בלבד.
            </p>
          </div>
          {candidate.warnings?.length ? (
            <div className="candidate-details-block">
              <h4>אזהרות</h4>
              <ul className="candidate-warning-list">
                {candidate.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TradePlanSummary({ plan }) {
  if (!plan || !plan.valid) {
    return <div className="trade-plan"><span className="cell-subtext">אין תוכנית יציאה תקינה</span></div>;
  }

  return (
    <div className="trade-plan">
      <div className="trade-plan-row">
        <span className="trade-plan-key">כניסה</span>
        <span className="trade-plan-value">${plan.entry.price}</span>
      </div>
      <div className="trade-plan-row">
        <span className="trade-plan-key">סטופ</span>
        <span className="trade-plan-value">
          ${plan.stop.price} <span className="cell-subtext">(-{plan.stop.distancePct}%)</span>
        </span>
      </div>
      <div className="trade-plan-row">
        <span className="trade-plan-key">יעד</span>
        <span className="trade-plan-value">
          ${plan.target.price} <span className="cell-subtext">({plan.target.rMultiple}R)</span>
        </span>
      </div>
      <div className="trade-plan-row">
        <span className="trade-plan-key">Time-stop</span>
        <span className="trade-plan-value">{plan.timeStopDays} ימי מסחר</span>
      </div>
      {plan.sizing ? (
        <div className="trade-plan-row">
          <span className="trade-plan-key">כמות</span>
          <span className="trade-plan-value">{plan.sizing.shares}</span>
        </div>
      ) : (
        <div className="trade-plan-row">
          <span className="cell-subtext">הזן סיכון בדולרים כדי לקבל כמות</span>
        </div>
      )}
    </div>
  );
}

// Explains "0 candidates" with the actual funnel counts (docs/SPEC_V2_ARCHITECTURE.md §6) instead
// of leaving an unexplained empty list.
function DiagnosticsPanel({ diagnostics }) {
  if (!diagnostics) {
    return null;
  }

  const rows = [
    diagnostics.universeCount != null ? ['universe', diagnostics.universeCount] : null,
    diagnostics.afterLiquidityGate != null ? ['אחרי שער נזילות', diagnostics.afterLiquidityGate] : null,
    diagnostics.afterSelection != null ? ['אחרי בחירה', diagnostics.afterSelection] : null,
    diagnostics.afterPlaybooks != null ? ['אחרי פלייבוקים', diagnostics.afterPlaybooks] : null
  ].filter(Boolean);

  return (
    <div className="diagnostics-panel">
      <h4>למה אין תוצאות</h4>
      {diagnostics.stage ? <p className="cell-subtext">נעצר בשלב: {diagnostics.stage}</p> : null}
      {rows.length ? (
        <ul className="diagnostics-rows">
          {rows.map(([label, value]) => (
            <li key={label}>
              {label}: {value}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BrokerMenu({ isOpen, onToggle, onClose }) {
  return (
    <div className="broker-menu-root" data-broker-menu-root="true">
      <button type="button" className="open-broker-button" onClick={onToggle} aria-expanded={isOpen} aria-haspopup="menu">
        פתח
      </button>

      {isOpen ? (
        <div className="broker-menu" role="menu">
          <p className="broker-menu-title">בחר מערכת מסחר לפתיחה</p>
          <div className="broker-menu-list">
            {BROKER_LINKS.map((broker) => (
              <button
                key={broker.id}
                type="button"
                className="broker-menu-item"
                role="menuitem"
                onClick={() => {
                  window.open(broker.url, '_blank', 'noopener,noreferrer');
                  onClose();
                }}
              >
                {broker.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export default App;

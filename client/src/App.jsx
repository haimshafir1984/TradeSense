import { useEffect, useState } from 'react';
import PortfolioSection from './components/PortfolioSection';

const exchangeOptions = [
  { value: 'NASDAQ', label: 'NASDAQ' },
  { value: 'NYSE', label: 'NYSE' },
  { value: 'TASE', label: 'TASE' }
];

const riskOptions = [
  { value: 'low', label: 'נמוכה' },
  { value: 'medium', label: 'בינונית' },
  { value: 'high', label: 'גבוהה' }
];

const investmentMethodOptions = [
  {
    value: 'micha_stocks',
    label: "השקעה לטווח ארוך - William O'Neil",
    shortLabel: "William O'Neil",
    description:
      'שיטת השקעה לטווח ארוך המשלבת מגמה חיובית, חוזק יחסי, הובלת שוק וקרבה למניות איכות עם בסיס פונדמנטלי חזק.'
  },
  {
    value: 'mark_minervini',
    label: 'מסחר לטווח קצר - Mark Minervini',
    shortLabel: 'Mark Minervini',
    description:
      'שיטת מסחר לטווח קצר המתמקדת במניות עם מומנטום חזק, חוזק יחסי גבוה ופריצות טכניות איכותיות.'
  },
  {
    value: 'ross_cameron',
    label: 'מומנטום קצר טווח (נתוני סוף יום) - Linda Bradford Raschke',
    shortLabel: 'Linda Raschke',
    description:
      'שיטה המתמקדת ב-price action, מומנטום קצר טווח ונפח חריג. מבוססת על נתוני סוף יום ולא על מסחר בזמן אמת - אינה תחליף למסך מסחר יומי חי.'
  },
  {
    value: 'swing_momentum',
    label: 'פריצות מומנטום (Swing)',
    shortLabel: 'Swing Momentum',
    description:
      'שיטת Swing המאתרת פריצות ממקדים צמודים או גאפים על קטליזטור עם נפח מסחר חריג, בתנאי שיש טווח תנודה יומי (ADR) משמעותי והמניה מעל ממוצע 200 יום. מבוססת על נתוני סוף יום.'
  },
  {
    value: 'small_cap_breakout',
    label: 'מניות קטנות נפיצות (Small-Cap)',
    shortLabel: 'Small-Cap Breakout',
    description:
      'מאתרת מניות קטנות (שווי שוק מתחת ל-2 מיליארד) עם נפח מסחר חריג ומומנטום חד - פוטנציאל תזוזה של עשרות אחוזים, אך בסיכון גבוה מקביל. דורשת גודל פוזיציה קטן ונקודת יציאה מוגדרת מראש.'
  }
];

const sectorOptions = [
  { value: 'Any', label: 'כל הסקטורים' },
  { value: 'Technology', label: 'טכנולוגיה' },
  { value: 'Healthcare', label: 'בריאות' },
  { value: 'Energy', label: 'אנרגיה' },
  { value: 'Finance', label: 'פיננסים' },
  { value: 'Consumer', label: 'צריכה' }
];

const marketCapOptions = [
  { value: 'any', label: 'הכול' },
  { value: 'large', label: 'Large Cap' },
  { value: 'mid', label: 'Mid Cap' },
  { value: 'small', label: 'Small Cap' }
];

const volatilityOptions = [
  { value: 'any', label: 'הכול' },
  { value: 'low', label: 'נמוכה' },
  { value: 'medium', label: 'בינונית' },
  { value: 'high', label: 'גבוהה' }
];

const BROKER_LINKS = [
  { id: 'ibi', label: 'IBI Trade', url: 'https://www.ibi.co.il/solutions/trading/' },
  { id: 'meitav', label: 'מיטב טרייד', url: 'https://www.meitav.co.il/trade/' },
  { id: 'interactive', label: 'Interactive Israel', url: 'https://www.inter-il.com/client-portal/' },
  { id: 'tradeon', label: 'TradeON', url: 'https://www.leumi.co.il/biz/Trade-On' },
  { id: 'atrade', label: 'ATRADE', url: 'https://www.atrade.co.il/' }
];

const initialFilters = {
  dividendOnly: false,
  minDividendYield: '',
  sector: 'Any',
  marketCap: 'any',
  minVolume: '',
  minPrice: '',
  maxPrice: '',
  volatility: 'any',
  unusualVolume: false
};

const numberFormatter = new Intl.NumberFormat('he-IL', {
  maximumFractionDigits: 2
});

// Mirrors OPPORTUNITY_RANK_BUCKETS in server/src/services/scanHistoryService.js - kept in sync by
// hand since it's just the display logic reading the server's own breakdown, not scoring itself.
const OPPORTUNITY_RANK_BUCKETS = [
  { label: '0-39', min: 0, max: 39 },
  { label: '40-59', min: 40, max: 59 },
  { label: '60-79', min: 60, max: 79 },
  { label: '80-100', min: 80, max: 100 }
];

function findOpportunityRankBucketLabel(opportunityRank) {
  return OPPORTUNITY_RANK_BUCKETS.find((bucket) => opportunityRank >= bucket.min && opportunityRank <= bucket.max)?.label;
}

// Mirrors WIDE_SCAN_STRATEGIES in server/src/services/scannerService.js - small_cap_breakout is
// excluded there deliberately (see docs/SPEC_SHORT_TERM_UPGRADE.md "סטיות מהתכנון").
const WIDE_SCAN_STRATEGIES = ['swing_momentum', 'ross_cameron'];

// Mirrors SHORT_TERM_STRATEGIES in server/src/services/scannerService.js - only these strategies'
// results carry (attempted, possibly-false) catalyst flags; other strategies leave them null.
const SHORT_TERM_STRATEGIES = ['ross_cameron', 'swing_momentum', 'small_cap_breakout'];

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function App() {
  const [activeTab, setActiveTab] = useState('watchlist');
  const [form, setForm] = useState({
    exchange: 'NASDAQ',
    risk: 'medium',
    strategy: 'micha_stocks',
    wideScan: false,
    filters: initialFilters
  });
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [openBrokerMenu, setOpenBrokerMenu] = useState(null);
  const [strategyLeague, setStrategyLeague] = useState(null);
  // Measured hit-rate/risk-profile stats per strategy+opportunityRank bucket (docs/SPEC_SHORT_TERM_UPGRADE.md
  // step 3) - lets each result show real, measured history instead of only the formula-based rank
  // once there's enough data. null until loaded / if the request fails - falls back to the
  // formula-only label, same as before this feature existed.
  const [hitRateReport, setHitRateReport] = useState(null);
  const [showTomorrowWatchlist, setShowTomorrowWatchlist] = useState(true);
  const [tomorrowWatchlist, setTomorrowWatchlist] = useState([]);
  const [tomorrowWatchlistGeneratedAt, setTomorrowWatchlistGeneratedAt] = useState(null);
  const [tomorrowWatchlistDataSource, setTomorrowWatchlistDataSource] = useState(null);
  const [tomorrowWatchlistLoading, setTomorrowWatchlistLoading] = useState(false);
  const [tomorrowWatchlistError, setTomorrowWatchlistError] = useState('');
  // Map-like object keyed by ticker: { [ticker]: { actualOpenPrice, gapAccuracyPct, ... } }.
  const [tomorrowWatchlistOutcomes, setTomorrowWatchlistOutcomes] = useState({});
  const [actualOpenInputs, setActualOpenInputs] = useState({});
  const [outcomeBusyTicker, setOutcomeBusyTicker] = useState(null);
  const [outcomeError, setOutcomeError] = useState('');
  // Vibe-Trading on-demand historical-check integration (see
  // docs/SPEC_VIBE_TRADING_INTEGRATION.md) - opt-in only, never fired automatically by a scan.
  const [vibeTradingEnabled, setVibeTradingEnabled] = useState(false);
  const [backtestBusyTicker, setBacktestBusyTicker] = useState(null);
  const [backtestTheoryBusy, setBacktestTheoryBusy] = useState(false);
  const [backtestModal, setBacktestModal] = useState(null); // { title, ok, report, message } | null
  // Risk framing (docs/SPEC_SHORT_TERM_UPGRADE.md step 2): a personal position-sizing input,
  // client-side only - never sent to the server, never affects scoring. Persisted locally so it
  // survives a refresh; empty by default so no quantity is shown until the user opts in.
  const [maxRiskPerTrade, setMaxRiskPerTrade] = useState(() => {
    try {
      return window.localStorage.getItem('tradesense.maxRiskPerTrade') || '';
    } catch {
      return '';
    }
  });

  const showIndiColumn = form.strategy === 'mark_minervini' || form.strategy === 'ross_cameron';
  const showCatalystColumn = SHORT_TERM_STRATEGIES.includes(form.strategy);

  const handleMaxRiskPerTradeChange = (value) => {
    setMaxRiskPerTrade(value);
    try {
      if (value) {
        window.localStorage.setItem('tradesense.maxRiskPerTrade', value);
      } else {
        window.localStorage.removeItem('tradesense.maxRiskPerTrade');
      }
    } catch {
      // localStorage can throw in private-browsing/blocked-storage contexts - the input still
      // works for the current session, it just won't persist across reloads.
    }
  };

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/api/strategy-league`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setStrategyLeague(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStrategyLeague(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/api/scan-history/outcomes`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setHitRateReport(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHitRateReport(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/api/backtest/status`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setVibeTradingEnabled(Boolean(data?.enabled));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVibeTradingEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const leadingStrategyLabel = strategyLeague?.leadingStrategy
    ? investmentMethodOptions.find((option) => option.value === strategyLeague.leadingStrategy)?.shortLabel
    : null;

  useEffect(() => {
    if (!openBrokerMenu) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!event.target.closest('[data-broker-menu-root="true"]')) {
        setOpenBrokerMenu(null);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpenBrokerMenu(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [openBrokerMenu]);

  const handleFieldChange = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleFilterChange = (field, value) => {
    setForm((current) => ({
      ...current,
      filters: {
        ...current.filters,
        [field]: value
      }
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsLoading(true);
    setError('');
    setHasSearched(true);
    setOpenBrokerMenu(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        throw new Error('הסריקה נכשלה. נסה שוב.');
      }

      const data = await response.json();
      setResults(data.results ?? []);
      setMeta(data.meta ?? null);
      setAnalysis(data.analysis ?? null);
    } catch (requestError) {
      setResults([]);
      setMeta(null);
      setAnalysis(null);
      setOpenBrokerMenu(null);
      setError(requestError.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCheckStockHistory = async (ticker) => {
    setBacktestBusyTicker(ticker);

    try {
      const response = await fetch(`${API_BASE_URL}/api/backtest/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, strategy: form.strategy })
      });
      const data = await response.json();
      setBacktestModal({ title: `בדיקה היסטורית — ${ticker}`, ...data });
    } catch (requestError) {
      setBacktestModal({ title: `בדיקה היסטורית — ${ticker}`, ok: false, message: requestError.message });
    } finally {
      setBacktestBusyTicker(null);
    }
  };

  const handleCheckTheory = async () => {
    setBacktestTheoryBusy(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/backtest/theory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: form.strategy })
      });
      const data = await response.json();
      setBacktestModal({ title: 'בדיקת תאוריה — האסטרטגיה שנבחרה', ...data });
    } catch (requestError) {
      setBacktestModal({ title: 'בדיקת תאוריה — האסטרטגיה שנבחרה', ok: false, message: requestError.message });
    } finally {
      setBacktestTheoryBusy(false);
    }
  };

  const handleLoadTomorrowWatchlist = async (forceRefresh = false) => {
    setTomorrowWatchlistLoading(true);
    setTomorrowWatchlistError('');

    try {
      const refreshParam = forceRefresh ? '&refresh=true' : '';
      const response = await fetch(`${API_BASE_URL}/api/watchlist/tomorrow?exchange=${form.exchange}${refreshParam}`);

      if (!response.ok) {
        throw new Error('טעינת רשימת המעקב נכשלה. נסה שוב.');
      }

      const data = await response.json();
      setTomorrowWatchlist(data.watchlist ?? []);
      setTomorrowWatchlistGeneratedAt(data.generatedAt ?? null);
      setTomorrowWatchlistDataSource(data.dataSource ?? null);
      await loadTomorrowWatchlistOutcomes(data.generatedAt ?? null);
    } catch (requestError) {
      setTomorrowWatchlist([]);
      setTomorrowWatchlistGeneratedAt(null);
      setTomorrowWatchlistDataSource(null);
      setTomorrowWatchlistOutcomes({});
      setTomorrowWatchlistError(requestError.message);
    } finally {
      setTomorrowWatchlistLoading(false);
    }
  };

  // Fetches logged actual-open outcomes for the trading date the current watchlist refers to
  // (generatedAt, truncated to YYYY-MM-DD), and merges them into state keyed by ticker.
  const loadTomorrowWatchlistOutcomes = async (generatedAt) => {
    if (!generatedAt) {
      setTomorrowWatchlistOutcomes({});
      return;
    }

    const date = generatedAt.slice(0, 10);

    try {
      const response = await fetch(`${API_BASE_URL}/api/watchlist/outcomes?date=${date}`);

      if (!response.ok) {
        setTomorrowWatchlistOutcomes({});
        return;
      }

      const data = await response.json();
      setTomorrowWatchlistOutcomes(data.outcomes ?? {});
    } catch (requestError) {
      setTomorrowWatchlistOutcomes({});
    }
  };

  const handleLogActualOpen = async (item) => {
    const date = (tomorrowWatchlistGeneratedAt || '').slice(0, 10);
    const rawValue = actualOpenInputs[item.ticker];
    const actualOpenPrice = Number(rawValue);

    if (!date || !rawValue || !Number.isFinite(actualOpenPrice) || actualOpenPrice <= 0) {
      setOutcomeError('יש להזין מחיר פתיחה בפועל חיובי.');
      return;
    }

    setOutcomeBusyTicker(item.ticker);
    setOutcomeError('');

    try {
      const response = await fetch(`${API_BASE_URL}/api/watchlist/outcomes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          ticker: item.ticker,
          actualOpenPrice,
          modelClosePrice: item.price,
          dailyChange: item.daily_change,
          volumeRatio: item.volumeRatio,
          adrPct: item.adr_pct,
          highProximity: item.highProximity,
          rankScore: item.rankScore
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'שמירת מחיר הפתיחה בפועל נכשלה.');
      }

      setTomorrowWatchlistOutcomes((current) => ({ ...current, [item.ticker]: data }));
    } catch (requestError) {
      setOutcomeError(requestError.message);
    } finally {
      setOutcomeBusyTicker(null);
    }
  };

  // Loaded automatically on mount and whenever the exchange changes - the server already computed
  // this the evening before (see watchlistScheduler.js), so it's ready without the user having to
  // ask for it.
  useEffect(() => {
    handleLoadTomorrowWatchlist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.exchange]);

  const emptyStateMessage = isLoading
    ? 'סורק את השוק...'
    : hasSearched
      ? meta?.noQualitySetups
        ? 'אין כרגע סטאפים איכותיים התואמים לאסטרטגיה שנבחרה. נסה שוב מאוחר יותר או שקול אסטרטגיה אחרת.'
        : 'לא נמצאו מניות שמתאימות לפילטרים שנבחרו. נסה להרחיב את הסינון או להחליף שיטת השקעה.'
      : 'עדיין אין תוצאות. מלא את הטופס ולחץ על "סרוק שוק".';

  return (
    <div className="page-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="topbar-brand">TradeSense</span>

          <nav className="topbar-tabs" role="tablist" aria-label="ניווט ראשי">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'watchlist'}
              className={`topbar-tab ${activeTab === 'watchlist' ? 'active' : ''}`}
              onClick={() => setActiveTab('watchlist')}
            >
              רשימת מעקב למחר
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'scan'}
              className={`topbar-tab ${activeTab === 'scan' ? 'active' : ''}`}
              onClick={() => setActiveTab('scan')}
            >
              סריקת שוק
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

          <div className="topbar-right">
            {analysis?.marketRegime ? (
              <span className={`source-badge regime ${regimeClassName(analysis.marketRegime.regime)}`}>
                מצב שוק: {analysis.marketRegime.label}
              </span>
            ) : null}
            {leadingStrategyLabel ? (
              <span className="strategy-league-badge">מובילה ב-90 הימים: {leadingStrategyLabel}</span>
            ) : null}
            <select
              className="topbar-exchange"
              value={form.exchange}
              onChange={(event) => handleFieldChange('exchange', event.target.value)}
              aria-label="בורסה"
            >
              {exchangeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="layout">
        {activeTab === 'watchlist' ? (
        <section className="card watchlist-card">
          <div className="section-head">
            <div>
              <h2>רשימת מעקב למחר</h2>
              <p>
                מועמדים ל-Gap &amp; Go ליום המסחר הבא. מחושבת אוטומטית מדי ערב - מוכנה כשאתה נכנס למערכת.
                {tomorrowWatchlistGeneratedAt ? ` עודכן לאחרונה: ${formatGeneratedAt(tomorrowWatchlistGeneratedAt)}.` : ''}
                {tomorrowWatchlistDataSource === 'alpaca+fmp' ? (
                  <span className="metric-pill high" style={{ marginRight: '0.5rem' }}>
                    מקור: סריקת שוק רחבה
                  </span>
                ) : tomorrowWatchlistDataSource === 'fmp-universe' ? (
                  <span className="metric-pill medium" style={{ marginRight: '0.5rem' }}>
                    מקור: מדגם מצומצם
                  </span>
                ) : null}
              </p>
            </div>
            <div className="watchlist-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => handleLoadTomorrowWatchlist(true)}
                disabled={tomorrowWatchlistLoading}
              >
                {tomorrowWatchlistLoading ? 'מרענן...' : 'רענן עכשיו'}
              </button>
              <button type="button" className="ghost-button" onClick={() => setShowTomorrowWatchlist((current) => !current)}>
                {showTomorrowWatchlist ? 'הסתר' : 'הצג'}
              </button>
            </div>
          </div>

          {showTomorrowWatchlist ? (
            <>
              <p className="watchlist-disclaimer">
                מבוסס נתוני סוף יום - לאימות מול מחירי פתיחה בזמן אמת לפני כל החלטה.
              </p>

              {tomorrowWatchlistError ? <p className="error-box">{tomorrowWatchlistError}</p> : null}
              {outcomeError ? <p className="error-box">{outcomeError}</p> : null}

              <div className="results-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>סימול</th>
                      <th>שם חברה</th>
                      <th>מחיר</th>
                      <th>שינוי יומי</th>
                      <th>יחס נפח</th>
                      <th>ADR%</th>
                      <th>דוח בקרוב</th>
                      <th>סיבה</th>
                      <th>סיכוי לפריצה</th>
                      <th>מחיר פתיחה בפועל</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tomorrowWatchlistLoading ? (
                      <tr>
                        <td colSpan={10} className="empty-state">
                          טוען רשימת מעקב...
                        </td>
                      </tr>
                    ) : tomorrowWatchlist.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="empty-state">
                          לא נמצאו כרגע מועמדים שעומדים בקריטריונים.
                        </td>
                      </tr>
                    ) : (
                      tomorrowWatchlist.map((item) => (
                        <tr key={item.ticker}>
                          <td>{item.ticker}</td>
                          <td>{item.companyName}</td>
                          <td>{numberFormatter.format(item.price)}</td>
                          <td className="value-tone positive">{item.daily_change}%</td>
                          <td>{item.volumeRatio}x</td>
                          <td>{item.adr_pct}%</td>
                          <td>
                            {item.hasEarningsSoon ? (
                              <span className="metric-pill medium">קטליזטור/סיכון: דוח בקרוב</span>
                            ) : (
                              <span className="cell-subtext">אין דוח קרוב ידוע</span>
                            )}
                          </td>
                          <td>{item.reason}</td>
                          <td>
                            <BreakoutLikelihoodCell likelihood={item.breakoutLikelihood} />
                          </td>
                          <td>
                            <ActualOpenCell
                              outcome={tomorrowWatchlistOutcomes[item.ticker]}
                              inputValue={actualOpenInputs[item.ticker] ?? ''}
                              busy={outcomeBusyTicker === item.ticker}
                              onChange={(value) =>
                                setActualOpenInputs((current) => ({ ...current, [item.ticker]: value }))
                              }
                              onSave={() => handleLogActualOpen(item)}
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
        ) : null}

        {activeTab === 'scan' ? (
        <div className="scan-layout">
        <aside className="card scan-settings">
          <div className="section-head compact">
            <h2>הגדרות סריקה</h2>
            <p>בחר רמת סיכון ושיטת השקעה, ולאחר מכן צמצם עם פילטרים מתקדמים.</p>
          </div>

          <form className="scanner-form" onSubmit={handleSubmit}>
            <div className="grid grid-primary">
              <Field label="רמת סיכון">
                <select value={form.risk} onChange={(event) => handleFieldChange('risk', event.target.value)}>
                  {riskOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="שיטת השקעה">
                <select value={form.strategy} onChange={(event) => handleFieldChange('strategy', event.target.value)}>
                  {investmentMethodOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="strategy-info-list">
              {investmentMethodOptions.map((option) => (
                <div key={option.value} className={`strategy-info-item ${form.strategy === option.value ? 'active' : ''}`}>
                  <span className="strategy-info-name">{option.shortLabel}</span>
                  <span className="tooltip-wrap" tabIndex="0" aria-label={option.description}>
                    i
                    <span className="tooltip-box">{option.description}</span>
                  </span>
                </div>
              ))}
            </div>

            {WIDE_SCAN_STRATEGIES.includes(form.strategy) ? (
              <>
                <Checkbox
                  label="סריקה רחבה (אלפי מניות, ~40-70 שניות)"
                  checked={form.wideScan}
                  onChange={(checked) => handleFieldChange('wideScan', checked)}
                />
                <p className="advanced-panel-hint">
                  מרחיבה את הסריקה מעבר למאגר הרגיל, כדי לגלות מניות שלא נמצאות בו - עלולה לקחת יותר זמן. אם לא זמינה כרגע, הסריקה נופלת חזרה למאגר הרגיל ומצוין הדבר בתוצאות.
                </p>
              </>
            ) : null}

            <Field label="סיכון מקסימלי לעסקה ($) - אופציונלי">
              <input
                type="number"
                min="0"
                step="1"
                value={maxRiskPerTrade}
                onChange={(event) => handleMaxRiskPerTradeChange(event.target.value)}
                placeholder="למשל 200"
              />
            </Field>
            <p className="advanced-panel-hint">
              משמש רק לחישוב כמות מניות מוצעת בטבלת התוצאות, לפי מרחק הסטופ הטכני. נשמר במכשיר הזה בלבד ולא נשלח לשרת.
            </p>

            <details className="advanced-panel">
              <summary>פילטרים מתקדמים</summary>
              <p className="advanced-panel-hint">כל הפילטרים חלים לפני חישוב ניקוד האסטרטגיה.</p>

              <div className="grid grid-secondary">
                <Field label="סקטור">
                  <select value={form.filters.sector} onChange={(event) => handleFilterChange('sector', event.target.value)}>
                    {sectorOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="שווי שוק">
                  <select value={form.filters.marketCap} onChange={(event) => handleFilterChange('marketCap', event.target.value)}>
                    {marketCapOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="תנודתיות">
                  <select value={form.filters.volatility} onChange={(event) => handleFilterChange('volatility', event.target.value)}>
                    {volatilityOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="מינימום תשואת דיבידנד">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.filters.minDividendYield}
                    onChange={(event) => handleFilterChange('minDividendYield', event.target.value)}
                    placeholder="למשל 2.5"
                  />
                </Field>

                <Field label="מינימום נפח">
                  <input
                    type="number"
                    min="0"
                    value={form.filters.minVolume}
                    onChange={(event) => handleFilterChange('minVolume', event.target.value)}
                    placeholder="למשל 1000000"
                  />
                </Field>

                <Field label="טווח מחיר">
                  <div className="price-range">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.filters.minPrice}
                      onChange={(event) => handleFilterChange('minPrice', event.target.value)}
                      placeholder="מינימום"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.filters.maxPrice}
                      onChange={(event) => handleFilterChange('maxPrice', event.target.value)}
                      placeholder="מקסימום"
                    />
                  </div>
                </Field>
              </div>

              <div className="toggle-grid">
                <Checkbox label="דיבידנד בלבד" checked={form.filters.dividendOnly} onChange={(checked) => handleFilterChange('dividendOnly', checked)} />
                <Checkbox label="נפח חריג" checked={form.filters.unusualVolume} onChange={(checked) => handleFilterChange('unusualVolume', checked)} />
              </div>
            </details>

            <button className="submit-button" type="submit" disabled={isLoading}>
              {isLoading ? 'סורק את השוק...' : 'סרוק שוק'}
            </button>

            {error ? <p className="error-box">{error}</p> : null}
          </form>
        </aside>

        <section className="card results-card">
          <div className="section-head">
            <h2>תוצאות</h2>
            <p>
              {meta
                ? `נותחו ${numberFormatter.format(meta.analyzedCount)} מניות, הוחזרו ${numberFormatter.format(meta.returnedCount)} תוצאות`
                : 'המערכת תחזיר את 10 המניות המובילות לפי שיטת ההשקעה שנבחרה.'}
            </p>
          </div>

          {meta ? (
            <div className="result-meta-bar">
              <span className={`source-badge ${sourceClassName(meta.source)}`}>מקור נתונים: {sourceLabel(meta.source)}</span>
              {meta.wideScanUsed ? <span className="source-badge">סריקה רחבה הופעלה</span> : null}
              {vibeTradingEnabled ? (
                <button
                  type="button"
                  className="vibe-trading-theory-button"
                  onClick={handleCheckTheory}
                  disabled={backtestTheoryBusy}
                  title="בודק את חוקי האסטרטגיה על מדגם מניות היסטורי (Vibe-Trading + DeepSeek, בלחיצה בלבד - כ-30-90 שניות, עלות זניחה)"
                >
                  {backtestTheoryBusy ? 'בודק תאוריה…' : 'בדוק תאוריה היסטורית'}
                </button>
              ) : null}
              {analysis?.marketRegime ? (
                <span className={`source-badge fit ${fitClassName(analysis.marketRegime.strategyFit?.level)}`}>
                  התאמת אסטרטגיה: {analysis.marketRegime.strategyFit?.label || 'בינונית'}
                </span>
              ) : null}
              {analysis?.summary?.averageOpportunityRank ? (
                <>
                  <span className="source-badge metric">ציון הזדמנות ממוצע: {analysis.summary.averageOpportunityRank}</span>
                  <span className="source-badge metric">תשואה משוקללת ממוצעת: {analysis.summary.averageExpectedReturnPct}%</span>
                </>
              ) : null}
              {analysis?.marketRegime?.strategyFit?.note ? (
                <p className="market-regime-note">{analysis.marketRegime.strategyFit.note}</p>
              ) : null}
              <RegimeRecommendationNote marketRegime={analysis?.marketRegime} selectedStrategy={meta?.strategy} />
              {analysis?.dataQuality?.issues?.length ? (
                <ul className="data-quality-issues">
                  {analysis.dataQuality.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {form.strategy === 'small_cap_breakout' ? (
            <p className="watchlist-disclaimer">
              אסטרטגיה בסיכון גבוה: מניות קטנות יכולות לנוע בעשרות אחוזים לשני הכיוונים. מומלץ גודל פוזיציה קטן ונקודת יציאה מוגדרת מראש.
            </p>
          ) : null}

          <div className="results-wrapper">
            <table>
              <thead>
                <tr>
                  <th>סימול</th>
                  <th>שם חברה</th>
                  <th>אחוז התאמה</th>
                  <th>ציון הזדמנות (יחסי)</th>
                  <th>פוטנציאל מהלך</th>
                  <th>תשואה משוקללת</th>
                  <th>מסגור סיכון (טכני)</th>
                  {showIndiColumn ? <th>התאמה ל-Indi</th> : null}
                  {showCatalystColumn ? <th>קטליזטור/סיכון</th> : null}
                  <th>אסטרטגיה</th>
                  <th>הסבר קצר</th>
                  <th>פתיחה</th>
                  {vibeTradingEnabled ? <th>בדיקה היסטורית</th> : null}
                </tr>
              </thead>
              <tbody>
                {results.length === 0 ? (
                  <tr>
                    <td
                      colSpan={
                        (showIndiColumn ? 11 : 10) + (showCatalystColumn ? 1 : 0) + (vibeTradingEnabled ? 1 : 0)
                      }
                      className="empty-state"
                    >
                      {emptyStateMessage}
                    </td>
                  </tr>
                ) : (
                  results.map((result) => (
                    <tr key={result.ticker}>
                      <td>{result.ticker}</td>
                      <td>{result.companyName}</td>
                      <td>{result.matchScore}%</td>
                      <td>
                        <span className={`metric-pill ${probabilityClassName(result.opportunityRank)}`}>
                          {result.opportunityRank}
                        </span>
                        <MeasuredOpportunityNote
                          strategy={form.strategy}
                          opportunityRank={result.opportunityRank}
                          hitRateReport={hitRateReport}
                        />
                      </td>
                      <td>{result.estimatedUpsideRange}</td>
                      <td>
                        <div className="value-tone positive">{result.expectedReturnPct}%</div>
                        <div className="cell-subtext">{result.opportunity?.recommendationLabel}</div>
                      </td>
                      <td>
                        <RiskFramingCell riskFraming={result.riskFraming} price={result.price} maxRiskPerTrade={maxRiskPerTrade} />
                      </td>
                      {showIndiColumn ? (
                        <td>
                          <IndiFitCell indiFit={result.indiFit} />
                        </td>
                      ) : null}
                      {showCatalystColumn ? (
                        <td>
                          <CatalystCell
                            hasEarningsSoon={result.hasEarningsSoon}
                            hasRecentNews={result.hasRecentNews}
                            recentNewsCount={result.recentNewsCount}
                          />
                        </td>
                      ) : null}
                      <td>
                        <div>{result.strategyName}</div>
                        <div className="cell-subtext">ראשי: {result.expertSupport?.primary?.shortName || 'האסטרטגיה הנבחרת'}</div>
                      </td>
                      <td>
                        <div>{result.explanation}</div>
                        <ExpertSupportSummary expertSupport={result.expertSupport} />
                      </td>
                      <td className="broker-menu-cell">
                        <BrokerMenu
                          isOpen={openBrokerMenu === result.ticker}
                          onToggle={() => setOpenBrokerMenu((current) => (current === result.ticker ? null : result.ticker))}
                          onClose={() => setOpenBrokerMenu(null)}
                        />
                      </td>
                      {vibeTradingEnabled ? (
                        <td>
                          <button
                            type="button"
                            className="vibe-trading-stock-button"
                            onClick={() => handleCheckStockHistory(result.ticker)}
                            disabled={backtestBusyTicker === result.ticker}
                            title="בודק מה המניה הזו עשתה בעבר בתבניות דומות (Vibe-Trading + DeepSeek, בלחיצה בלבד)"
                          >
                            {backtestBusyTicker === result.ticker ? 'בודק…' : 'בדוק היסטורית'}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        </div>
        ) : null}

        {activeTab === 'portfolio' ? <PortfolioSection apiBaseUrl={API_BASE_URL} /> : null}
      </main>

      {backtestModal ? <BacktestReportModal modal={backtestModal} onClose={() => setBacktestModal(null)} /> : null}
    </div>
  );
}

// Shows the plain-text/markdown report a Vibe-Trading run returns, or the error/disabled message
// if it failed. This is deliberately a raw text dump, not a parsed/styled report - the run's own
// output already reads fine as markdown-ish text, and parsing it would be brittle against
// whatever the agent happens to write this time. See docs/SPEC_VIBE_TRADING_INTEGRATION.md.
function BacktestReportModal({ modal, onClose }) {
  return (
    <div className="backtest-modal-overlay" onClick={onClose}>
      <div className="backtest-modal" onClick={(event) => event.stopPropagation()}>
        <div className="backtest-modal-header">
          <h3>{modal.title}</h3>
          <button type="button" className="backtest-modal-close" onClick={onClose} aria-label="סגור">
            ✕
          </button>
        </div>
        {modal.ok ? (
          <>
            <p className="backtest-modal-disclaimer">
              בדיקה היסטורית חד-פעמית דרך Vibe-Trading (DeepSeek) - לא ייעוץ השקעות, ולא תמיד בדיקה על universe מלא. ראו
              docs/BACKTEST_FINDINGS.md להסתייגויות המלאות.
            </p>
            <pre className="backtest-modal-report">{modal.report}</pre>
          </>
        ) : (
          <p className="backtest-modal-error">{modal.message}</p>
        )}
      </div>
    </div>
  );
}

function RegimeRecommendationNote({ marketRegime, selectedStrategy }) {
  if (!marketRegime) {
    return null;
  }

  const recommendation = marketRegime.recommendedStrategy;
  const notes = [];

  if (recommendation?.key && recommendation.key !== selectedStrategy) {
    const sourceLabel = recommendation.source === 'league' ? 'מבוסס ביצועים נמדדים' : 'מבוסס מצב שוק';
    notes.push(
      `בתנאי השוק הנוכחיים (${marketRegime.label}) לוגיקת ${recommendation.label} מתאימה יותר (${sourceLabel}).`
    );
  }

  if (marketRegime.regime === 'bearish') {
    notes.push('השוק חלש, שקול להקטין חשיפה.');
  }

  // Damping banner for the two highest-risk strategies (docs/SPEC_SHORT_TERM_UPGRADE.md step 6) -
  // based on the smoothed (multi-day) regime, not a single potentially-noisy same-day reading.
  // Doesn't block the scan, just prices the risk in - see docs/BACKTEST_FINDINGS.md for the
  // backtest evidence behind this.
  const dampedStrategies = ['small_cap_breakout', 'swing_momentum'];
  const riskyRegimes = ['bearish', 'volatile'];
  if (dampedStrategies.includes(selectedStrategy) && riskyRegimes.includes(marketRegime.smoothedRegime)) {
    notes.push(
      'במשטר שוק כזה (על פני כמה ימים) הסגנון הזה נטה היסטורית לביצועים חלשים - ראו docs/BACKTEST_FINDINGS.md. לא נחסמת הסריקה, אך כדאי לתמחר את הסיכון בהתאם.'
    );
  }

  if (!notes.length) {
    return null;
  }

  return (
    <>
      {notes.map((note) => (
        <p key={note} className="market-regime-note">
          {note}
        </p>
      ))}
    </>
  );
}

// Shows what happened historically to logged candidates that scored similarly to this one
// (watchlistLearningService.js, computed server-side from watchlistOutcomes.json). Below the
// minimum sample size it says so explicitly rather than showing a percentage that would look
// scientific but rest on a handful of data points.
function BreakoutLikelihoodCell({ likelihood }) {
  if (!likelihood || likelihood.positiveGapRatePct === null) {
    const sampleSize = likelihood?.sampleSize ?? 0;
    const minSampleSize = likelihood?.minSampleSize ?? 5;
    return (
      <span className="cell-subtext">
        אין עדיין מספיק נתונים ({sampleSize}/{minSampleSize} תצפיות)
      </span>
    );
  }

  return (
    <span className={`metric-pill ${likelihood.positiveGapRatePct >= 50 ? 'high' : 'low'}`}>
      {likelihood.positiveGapRatePct}% גאפ חיובי (ממוצע {likelihood.avgGapPct > 0 ? '+' : ''}
      {likelihood.avgGapPct}%, {likelihood.sampleSize} תצפיות דומות)
    </span>
  );
}

// Lets the user log the real next-morning opening price for a gap-and-go candidate and see how
// it compares to the model's close price (gapAccuracyPct). Before logging (or while editing): a
// small input + save button. After logging: a colored pill (green when the gap matched the
// direction the watchlist predicted - i.e. a positive gap - red otherwise), with an "edit" option
// that switches back to the input, pre-filled with the previously logged price.
function ActualOpenCell({ outcome, inputValue, busy, onChange, onSave }) {
  const [isEditing, setIsEditing] = useState(false);

  if (outcome && !isEditing) {
    return (
      <div className="actual-open-cell">
        <span className={`metric-pill ${outcome.gapAccuracyPct >= 0 ? 'high' : 'low'}`}>
          גאפ בפועל: {outcome.gapAccuracyPct > 0 ? '+' : ''}
          {outcome.gapAccuracyPct}%
        </span>
        <button
          type="button"
          className="table-action-button"
          onClick={() => {
            onChange(String(outcome.actualOpenPrice));
            setIsEditing(true);
          }}
        >
          ערוך
        </button>
      </div>
    );
  }

  return (
    <div className="actual-open-cell">
      <input
        type="number"
        min="0"
        step="0.01"
        className="actual-open-input"
        value={inputValue}
        onChange={(event) => onChange(event.target.value)}
        placeholder="מחיר פתיחה"
      />
      <button
        type="button"
        className="table-action-button"
        onClick={() => {
          onSave();
          setIsEditing(false);
        }}
        disabled={busy}
      >
        {busy ? 'שומר...' : 'שמור'}
      </button>
    </div>
  );
}

// Replaces the old "success probability" framing with an honest split (docs/SPEC_SHORT_TERM_UPGRADE.md
// step 3): once there's enough measured scan history (>=10 evaluated samples in the last 90 days,
// same strategy + opportunityRank bucket as this result), show the actual measured hit-rate and
// risk profile instead of only the formula-based relative rank.
function MeasuredOpportunityNote({ strategy, opportunityRank, hitRateReport }) {
  const bucketLabel = findOpportunityRankBucketLabel(opportunityRank);
  const cell = hitRateReport?.byStrategyAndBucket?.byStrategy?.[strategy]?.[bucketLabel];

  if (!cell || cell.insufficientSamples) {
    return <div className="cell-subtext">מבוסס נוסחה, טרם נמדד מספיק</div>;
  }

  return (
    <div className="cell-subtext">
      נמדד: {cell.hits} מתוך {cell.count} עלו מעל ה-benchmark תוך {cell.horizonDays} ימים · חציון {cell.medianReturnPct}% ·
      הגרוע ביותר {cell.worstReturnPct}% · {cell.pctBelowMinus10}% ירדו מעל 10%
    </div>
  );
}

// Both flags are informational only - neither feeds any strategy's score
// (docs/SPEC_SHORT_TERM_UPGRADE.md step 5). null means "not checked" (e.g. no provider key
// configured), shown differently from a confirmed "no" so the user isn't given false confidence.
function CatalystCell({ hasEarningsSoon, hasRecentNews, recentNewsCount }) {
  if (hasEarningsSoon === null && hasRecentNews === null) {
    return <span className="cell-subtext">לא נבדק</span>;
  }

  return (
    <div>
      {hasEarningsSoon ? (
        <span className="metric-pill medium">קטליזטור/סיכון: דוח בקרוב</span>
      ) : (
        <div className="cell-subtext">אין דוח קרוב ידוע</div>
      )}
      {hasRecentNews ? (
        <div className="cell-subtext">יש אירוע חדשותי ({recentNewsCount}) - בדוק לפני החלטה</div>
      ) : null}
    </div>
  );
}

// Purely a mechanical calculation shown for the user's own judgment - never a recommendation to
// enter/exit a position. Quantity only appears once the user opts into the (client-side-only,
// never sent to the server) "max risk per trade" field. See docs/SPEC_SHORT_TERM_UPGRADE.md step 2.
function RiskFramingCell({ riskFraming, price, maxRiskPerTrade }) {
  if (!riskFraming || riskFraming.stopDistancePct == null) {
    return <span className="cell-subtext">אין מספיק נתוני תנודתיות</span>;
  }

  const maxRisk = Number(maxRiskPerTrade);
  const perShareRisk = Number(price) - Number(riskFraming.stopPrice);
  const quantity = Number.isFinite(maxRisk) && maxRisk > 0 && perShareRisk > 0
    ? Math.floor(maxRisk / perShareRisk)
    : null;

  return (
    <div>
      <div>סטופ מוצע: ${riskFraming.stopPrice} ({riskFraming.stopDistancePct}%)</div>
      {riskFraming.rewardRiskRatio != null ? <div>יחס סיכוי/סיכון: {riskFraming.rewardRiskRatio}</div> : null}
      {quantity != null ? <div>כמות לפי הסיכון שהוגדר: {quantity}</div> : null}
      <div className="cell-subtext">מרחק סטופ לפי טווח התנודה היומי - חישוב טכני, לא ייעוץ</div>
    </div>
  );
}

function IndiFitCell({ indiFit }) {
  if (!indiFit) {
    return <span className="cell-subtext">לא רלוונטי</span>;
  }

  return (
    <div>
      <span className={`metric-pill ${indiFitClassName(indiFit.label)}`}>{indiFit.label}</span>
      <div className="cell-subtext">{indiFit.note}</div>
    </div>
  );
}

function ExpertSupportSummary({ expertSupport }) {
  const supporters = expertSupport?.supporters || [];

  if (!supporters.length) {
    return <div className="cell-subtext expert-support-empty">ללא תמיכה חזקה נוספת</div>;
  }

  return (
    <div className="expert-support-row">
      <span className="cell-subtext">תמיכה:</span>
      <div className="expert-support-badges">
        {supporters.slice(0, 2).map((expert) => (
          <span key={expert.id} className="expert-support-badge">
            {expert.shortName}
          </span>
        ))}
        {supporters.length > 2 ? <span className="expert-support-badge">+{supporters.length - 2}</span> : null}
      </div>
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

function Checkbox({ label, checked, onChange }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function formatGeneratedAt(isoString) {
  try {
    return new Date(isoString).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function sourceClassName(source) {
  if (
    source === 'fmp' ||
    source === 'finnhub' ||
    source === 'alpaca+nasdaq' ||
    source === 'alpaca+fmp-screener' ||
    source === 'alpaca+finnhub' ||
    source === 'alpaca+wide-scan'
  ) {
    return 'live';
  }
  if (source === 'fmp_partial' || source === 'finnhub_partial') return 'partial';
  return 'demo';
}

function sourceLabel(source) {
  if (source === 'fmp') return 'נתוני אמת (FMP)';
  if (source === 'fmp_partial') return 'נתונים חיים חלקיים (FMP)';
  if (source === 'finnhub') return 'נתוני אמת (Finnhub)';
  if (source === 'finnhub_partial') return 'נתונים חיים חלקיים (Finnhub)';
  if (source === 'alpaca+nasdaq') return 'נתוני אמת (Alpaca+Nasdaq)';
  if (source === 'alpaca+fmp-screener') return 'נתוני אמת (Alpaca+FMP)';
  if (source === 'alpaca+finnhub') return 'נתוני אמת (Alpaca+Finnhub)';
  if (source === 'alpaca+wide-scan') return 'נתוני אמת (סריקה רחבה)';
  return 'נתוני דמו';
}

function regimeClassName(regime) {
  if (regime === 'bullish') return 'live';
  if (regime === 'volatile') return 'partial';
  if (regime === 'bearish') return 'demo';
  return '';
}

function fitClassName(level) {
  if (level === 'high') return 'live';
  if (level === 'low') return 'demo';
  return 'partial';
}

function probabilityClassName(value) {
  if (value >= 75) return 'high';
  if (value >= 55) return 'medium';
  return 'low';
}

function indiFitClassName(label) {
  if (label === 'חזקה' || label === 'כן') return 'high';
  if (label === 'מעקב') return 'medium';
  return 'low';
}

export default App;

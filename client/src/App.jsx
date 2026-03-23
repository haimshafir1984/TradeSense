import { useEffect, useState } from 'react';

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
    label: 'השקעה לטווח ארוך - Micha Stocks',
    shortLabel: 'Micha Stocks',
    description:
      'שיטת השקעה לטווח ארוך המתמקדת במניות עם מגמה חיובית חזקה ושילוב של ניתוח טכני ופונדמנטלי.'
  },
  {
    value: 'mark_minervini',
    label: 'מסחר לטווח קצר - Mark Minervini',
    shortLabel: 'Mark Minervini',
    description: 'שיטת מסחר לטווח קצר המתמקדת במניות עם מומנטום חזק ופריצות טכניות.'
  },
  {
    value: 'ross_cameron',
    label: 'מסחר יומי - Ross Cameron',
    shortLabel: 'Ross Cameron',
    description: 'שיטת מסחר יומי המתמקדת במניות עם תנודתיות גבוהה ונפח מסחר חריג.'
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
  unusualVolume: false,
  institutionalBuying: false,
  insiderBuying: false
};

const numberFormatter = new Intl.NumberFormat('he-IL', {
  maximumFractionDigits: 2
});

function App() {
  const [form, setForm] = useState({
    exchange: 'NASDAQ',
    risk: 'medium',
    strategy: 'micha_stocks',
    filters: initialFilters
  });
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [openBrokerMenu, setOpenBrokerMenu] = useState(null);

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

    console.log('[TradeSense] Starting scan', form);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        throw new Error('הסריקה נכשלה. נסה שוב.');
      }

      const data = await response.json();
      console.log('[TradeSense] Scan response', data);
      setResults(data.results ?? []);
      setMeta(data.meta ?? null);
    } catch (requestError) {
      console.error('[TradeSense] Scan failed', requestError);
      setResults([]);
      setMeta(null);
      setOpenBrokerMenu(null);
      setError(requestError.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBrokerSelect = (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    setOpenBrokerMenu(null);
  };

  const emptyStateMessage = isLoading
    ? 'סורק את השוק...'
    : hasSearched
      ? 'לא נמצאו מניות שמתאימות לפילטרים שנבחרו. נסה להרחיב את הסינון או להחליף שיטת השקעה.'
      : 'עדיין אין תוצאות. מלא את הטופס ולחץ על "סרוק שוק".';

  return (
    <div className="page-shell">
      <div className="aurora aurora-left" />
      <div className="aurora aurora-right" />

      <main className="layout">
        <section className="hero">
          <p className="eyebrow">בורסה חכמה לסינון מניות</p>
          <h1>TradeSense</h1>
          <p className="hero-copy">
            מנוע סריקה שמדרג מניות לפי שיטת השקעה, רמת סיכון ופילטרים מתקדמים על בסיס
            נתוני שוק אמיתיים.
          </p>
        </section>

        <section className="card form-card">
          <div className="section-head">
            <h2>הגדרות סריקה</h2>
            <p>בחר שוק, רמת סיכון ושיטת השקעה, ולאחר מכן צמצם עם פילטרים מתקדמים.</p>
          </div>

          <form className="scanner-form" onSubmit={handleSubmit}>
            <div className="grid grid-primary">
              <Field label="בורסה">
                <select
                  value={form.exchange}
                  onChange={(event) => handleFieldChange('exchange', event.target.value)}
                >
                  {exchangeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="רמת סיכון">
                <select
                  value={form.risk}
                  onChange={(event) => handleFieldChange('risk', event.target.value)}
                >
                  {riskOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="שיטת השקעה">
                <select
                  value={form.strategy}
                  onChange={(event) => handleFieldChange('strategy', event.target.value)}
                >
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
                <div
                  key={option.value}
                  className={`strategy-info-item ${form.strategy === option.value ? 'active' : ''}`}
                >
                  <span className="strategy-info-name">{option.shortLabel}</span>
                  <span className="tooltip-wrap" tabIndex="0" aria-label={option.description}>
                    i
                    <span className="tooltip-box">{option.description}</span>
                  </span>
                </div>
              ))}
            </div>

            <div className="advanced-panel">
              <div className="section-head compact">
                <h3>פילטרים מתקדמים</h3>
                <p>כל הפילטרים חלים לפני חישוב ניקוד האסטרטגיה.</p>
              </div>

              <div className="grid grid-secondary">
                <Field label="סקטור">
                  <select
                    value={form.filters.sector}
                    onChange={(event) => handleFilterChange('sector', event.target.value)}
                  >
                    {sectorOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="שווי שוק">
                  <select
                    value={form.filters.marketCap}
                    onChange={(event) => handleFilterChange('marketCap', event.target.value)}
                  >
                    {marketCapOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="תנודתיות">
                  <select
                    value={form.filters.volatility}
                    onChange={(event) => handleFilterChange('volatility', event.target.value)}
                  >
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
                    onChange={(event) =>
                      handleFilterChange('minDividendYield', event.target.value)
                    }
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
                <Checkbox
                  label="דיבידנד בלבד"
                  checked={form.filters.dividendOnly}
                  onChange={(checked) => handleFilterChange('dividendOnly', checked)}
                />
                <Checkbox
                  label="נפח חריג"
                  checked={form.filters.unusualVolume}
                  onChange={(checked) => handleFilterChange('unusualVolume', checked)}
                />
                <Checkbox
                  label="רכישות מוסדיות"
                  checked={form.filters.institutionalBuying}
                  onChange={(checked) => handleFilterChange('institutionalBuying', checked)}
                />
                <Checkbox
                  label="רכישות פנים"
                  checked={form.filters.insiderBuying}
                  onChange={(checked) => handleFilterChange('insiderBuying', checked)}
                />
              </div>
            </div>

            <button className="submit-button" type="submit" disabled={isLoading}>
              {isLoading ? 'סורק את השוק...' : 'סרוק שוק'}
            </button>

            {error ? <p className="error-box">{error}</p> : null}
          </form>
        </section>

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
              <span
                className={`source-badge ${
                  meta.source === 'fmp' || meta.source === 'finnhub'
                    ? 'live'
                    : meta.source === 'fmp_partial' || meta.source === 'finnhub_partial'
                      ? 'partial'
                      : 'demo'
                }`}
              >
                מקור נתונים:{' '}
                {meta.source === 'fmp'
                  ? 'נתוני אמת (FMP)'
                  : meta.source === 'fmp_partial'
                    ? 'נתונים חיים חלקיים (FMP)'
                    : meta.source === 'finnhub'
                      ? 'נתוני אמת (Finnhub)'
                      : meta.source === 'finnhub_partial'
                        ? 'נתונים חיים חלקיים (Finnhub)'
                        : 'נתוני דמו'}
              </span>
            </div>
          ) : null}

          <div className="results-wrapper">
            <table>
              <thead>
                <tr>
                  <th>סימול</th>
                  <th>שם חברה</th>
                  <th>אחוז התאמה</th>
                  <th>אסטרטגיה</th>
                  <th>הסבר קצר</th>
                  <th>פתיחה</th>
                </tr>
              </thead>
              <tbody>
                {results.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="empty-state">
                      {emptyStateMessage}
                    </td>
                  </tr>
                ) : (
                  results.map((result) => (
                    <tr key={result.ticker}>
                      <td>{result.ticker}</td>
                      <td>{result.companyName}</td>
                      <td>{result.matchScore}%</td>
                      <td>{result.strategyName}</td>
                      <td>{result.explanation}</td>
                      <td className="broker-menu-cell">
                        <div className="broker-menu-root" data-broker-menu-root="true">
                          <button
                            type="button"
                            className="open-broker-button"
                            onClick={() =>
                              setOpenBrokerMenu((current) =>
                                current === result.ticker ? null : result.ticker
                              )
                            }
                            aria-expanded={openBrokerMenu === result.ticker}
                            aria-haspopup="menu"
                          >
                            פתח
                          </button>

                          {openBrokerMenu === result.ticker ? (
                            <div className="broker-menu" role="menu">
                              <p className="broker-menu-title">בחר מערכת מסחר לפתיחה</p>
                              <div className="broker-menu-list">
                                {BROKER_LINKS.map((broker) => (
                                  <button
                                    key={broker.id}
                                    type="button"
                                    className="broker-menu-item"
                                    onClick={() => handleBrokerSelect(broker.url)}
                                    role="menuitem"
                                  >
                                    {broker.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
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
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export default App;

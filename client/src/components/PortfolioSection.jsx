import { useEffect, useState } from 'react';

const initialHoldingForm = {
  ticker: '',
  quantity: '',
  investedAmount: '',
  averageBuyPrice: '',
  purchaseDate: '',
  note: ''
};

const initialWatchlistForm = {
  ticker: '',
  note: ''
};

const numberFormatter = new Intl.NumberFormat('he-IL', {
  maximumFractionDigits: 2
});

const currencyFormatter = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2
});

function PortfolioSection({ apiBaseUrl }) {
  const [portfolio, setPortfolio] = useState({
    holdings: [],
    watchlist: [],
    summary: null
  });
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioError, setPortfolioError] = useState('');
  const [holdingForm, setHoldingForm] = useState(initialHoldingForm);
  const [watchlistForm, setWatchlistForm] = useState(initialWatchlistForm);
  const [portfolioBusy, setPortfolioBusy] = useState(false);

  useEffect(() => {
    loadPortfolio();
  }, []);

  async function loadPortfolio() {
    setPortfolioLoading(true);
    setPortfolioError('');

    try {
      const response = await fetch(`${apiBaseUrl}/api/portfolio`);

      if (!response.ok) {
        throw new Error('טעינת האזור האישי נכשלה.');
      }

      const data = await response.json();
      setPortfolio({
        holdings: data.holdings ?? [],
        watchlist: data.watchlist ?? [],
        summary: data.summary ?? null
      });
    } catch (requestError) {
      setPortfolioError(requestError.message);
    } finally {
      setPortfolioLoading(false);
    }
  }

  async function submitPortfolioRequest(path, options) {
    setPortfolioBusy(true);
    setPortfolioError('');

    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: options.method,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'הפעולה באזור האישי נכשלה.');
      }

      setPortfolio({
        holdings: data.holdings ?? [],
        watchlist: data.watchlist ?? [],
        summary: data.summary ?? null
      });
    } catch (requestError) {
      setPortfolioError(requestError.message);
    } finally {
      setPortfolioBusy(false);
    }
  }

  const handleAddHolding = async (event) => {
    event.preventDefault();
    await submitPortfolioRequest('/api/portfolio/holdings', {
      method: 'POST',
      body: holdingForm
    });
    setHoldingForm(initialHoldingForm);
  };

  const handleAddWatchlistItem = async (event) => {
    event.preventDefault();
    await submitPortfolioRequest('/api/portfolio/watchlist', {
      method: 'POST',
      body: watchlistForm
    });
    setWatchlistForm(initialWatchlistForm);
  };

  return (
    <section className="card portfolio-card">
      <div className="section-head">
        <div>
          <h2>האזור האישי</h2>
          <p>ניהול אחזקות, שווי נוכחי, רווח והפסד, רשימת מעקב והערות אישיות.</p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={loadPortfolio}
          disabled={portfolioLoading || portfolioBusy}
        >
          {portfolioLoading ? 'מרענן...' : 'רענן נתונים'}
        </button>
      </div>

      {portfolioError ? <p className="error-box">{portfolioError}</p> : null}

      <div className="portfolio-summary-grid">
        <SummaryCard label="שווי תיק נוכחי" value={formatCurrency(portfolio.summary?.totalCurrentValue)} />
        <SummaryCard label="השקעה כוללת" value={formatCurrency(portfolio.summary?.totalInvested)} />
        <SummaryCard
          label="רווח / הפסד"
          value={`${formatCurrency(portfolio.summary?.totalGainLoss)} (${formatPercent(portfolio.summary?.totalGainLossPct)})`}
          tone={toneForNumber(portfolio.summary?.totalGainLoss)}
        />
        <SummaryCard label="מספר אחזקות" value={String(portfolio.summary?.holdingsCount ?? 0)} />
      </div>

      <div className="portfolio-summary-grid secondary">
        <SummaryCard
          label="החזקה מובילה"
          value={portfolio.summary?.bestHolding?.ticker || 'אין עדיין'}
          caption={
            portfolio.summary?.bestHolding
              ? `${portfolio.summary.bestHolding.companyName} • ${formatPercent(portfolio.summary.bestHolding.gainLossPct)}`
              : 'הוסף אחזקות כדי לראות ביצועים'
          }
        />
        <SummaryCard
          label="החזקה חלשה"
          value={portfolio.summary?.worstHolding?.ticker || 'אין עדיין'}
          caption={
            portfolio.summary?.worstHolding
              ? `${portfolio.summary.worstHolding.companyName} • ${formatPercent(portfolio.summary.worstHolding.gainLossPct)}`
              : 'המערכת תציג את המפסידה הבולטת'
          }
        />
        <SummaryCard label="רשימת מעקב" value={String(portfolio.summary?.watchlistCount ?? 0)} />
        <SummaryCard
          label="פיזור סקטורים"
          value={
            portfolio.summary?.sectorAllocation?.length
              ? portfolio.summary.sectorAllocation
                  .slice(0, 2)
                  .map((item) => `${item.sector} ${formatPercent(item.weightPct)}`)
                  .join(' • ')
              : 'אין פיזור עדיין'
          }
        />
      </div>

      <div className="portfolio-forms-grid">
        <form className="card inset-card" onSubmit={handleAddHolding}>
          <div className="section-head compact">
            <h3>הוסף אחזקה</h3>
            <p>הזן את העסקה כפי שבוצעה בפועל.</p>
          </div>

          <div className="grid grid-secondary">
            <Field label="סימול">
              <input
                value={holdingForm.ticker}
                onChange={(event) => setHoldingForm((current) => ({ ...current, ticker: event.target.value }))}
                placeholder="למשל AAPL"
              />
            </Field>
            <Field label="כמות">
              <input
                type="number"
                min="0"
                step="0.0001"
                value={holdingForm.quantity}
                onChange={(event) => setHoldingForm((current) => ({ ...current, quantity: event.target.value }))}
                placeholder="למשל 10"
              />
            </Field>
            <Field label="מחיר קנייה ממוצע">
              <input
                type="number"
                min="0"
                step="0.01"
                value={holdingForm.averageBuyPrice}
                onChange={(event) =>
                  setHoldingForm((current) => ({ ...current, averageBuyPrice: event.target.value }))
                }
                placeholder="למשל 182.4"
              />
            </Field>
            <Field label="סכום השקעה">
              <input
                type="number"
                min="0"
                step="0.01"
                value={holdingForm.investedAmount}
                onChange={(event) =>
                  setHoldingForm((current) => ({ ...current, investedAmount: event.target.value }))
                }
                placeholder="אם ריק יחושב אוטומטית"
              />
            </Field>
            <Field label="תאריך קנייה">
              <input
                type="date"
                value={holdingForm.purchaseDate}
                onChange={(event) => setHoldingForm((current) => ({ ...current, purchaseDate: event.target.value }))}
              />
            </Field>
            <Field label="הערה אישית">
              <input
                value={holdingForm.note}
                onChange={(event) => setHoldingForm((current) => ({ ...current, note: event.target.value }))}
                placeholder="למה נכנסת לעסקה"
              />
            </Field>
          </div>

          <button className="submit-button small" type="submit" disabled={portfolioBusy}>
            {portfolioBusy ? 'שומר...' : 'שמור אחזקה'}
          </button>
        </form>

        <form className="card inset-card" onSubmit={handleAddWatchlistItem}>
          <div className="section-head compact">
            <h3>רשימת מעקב</h3>
            <p>מניות שמעניינות אותך ועדיין לא נקנו.</p>
          </div>

          <div className="grid grid-secondary watchlist-form-grid">
            <Field label="סימול">
              <input
                value={watchlistForm.ticker}
                onChange={(event) => setWatchlistForm((current) => ({ ...current, ticker: event.target.value }))}
                placeholder="למשל MSFT"
              />
            </Field>
            <Field label="הערה">
              <input
                value={watchlistForm.note}
                onChange={(event) => setWatchlistForm((current) => ({ ...current, note: event.target.value }))}
                placeholder="מה אתה רוצה לבדוק"
              />
            </Field>
          </div>

          <button className="submit-button small" type="submit" disabled={portfolioBusy}>
            {portfolioBusy ? 'שומר...' : 'הוסף לרשימת המעקב'}
          </button>
        </form>
      </div>

      <div className="portfolio-section">
        <div className="section-head compact">
          <h3>אחזקות פעילות</h3>
          <p>{portfolioLoading ? 'טוען נתוני תיק...' : `נמצאו ${numberFormatter.format(portfolio.holdings.length)} אחזקות`}</p>
        </div>

        <div className="results-wrapper">
          <table>
            <thead>
              <tr>
                <th>סימול</th>
                <th>חברה</th>
                <th>כמות</th>
                <th>מחיר קנייה</th>
                <th>תאריך</th>
                <th>שווי נוכחי</th>
                <th>רווח / הפסד</th>
                <th>שינוי מאז קנייה</th>
                <th>שינוי יומי</th>
                <th>הערה</th>
                <th>פעולה</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.holdings.length === 0 ? (
                <tr>
                  <td colSpan="11" className="empty-state">
                    עדיין לא נוספו אחזקות. הוסף את הקנייה הראשונה שלך כדי להתחיל לעקוב.
                  </td>
                </tr>
              ) : (
                portfolio.holdings.map((holding) => (
                  <tr key={holding.id}>
                    <td>{holding.ticker}</td>
                    <td>{holding.companyName}</td>
                    <td>{numberFormatter.format(holding.quantity)}</td>
                    <td>
                      {formatCurrency(holding.averageBuyPrice)}
                      <div className="cell-subtext">השקעה: {formatCurrency(holding.investedAmount)}</div>
                    </td>
                    <td>{holding.purchaseDate}</td>
                    <td>
                      {formatCurrency(holding.currentValue)}
                      <div className="cell-subtext">מחיר נוכחי: {formatCurrency(holding.currentPrice)}</div>
                    </td>
                    <td>
                      <ValueTone value={holding.gainLossValue}>{formatCurrency(holding.gainLossValue)}</ValueTone>
                      <div className="cell-subtext">
                        <ValueTone value={holding.gainLossPct}>{formatPercent(holding.gainLossPct)}</ValueTone>
                      </div>
                    </td>
                    <td>
                      <ValueTone value={holding.changeFromBuyPricePct}>{formatPercent(holding.changeFromBuyPricePct)}</ValueTone>
                    </td>
                    <td>
                      <ValueTone value={holding.dailyChange}>{formatPercent(holding.dailyChange)}</ValueTone>
                    </td>
                    <td>{holding.note || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="table-action-button"
                        onClick={() => submitPortfolioRequest(`/api/portfolio/holdings/${holding.id}`, { method: 'DELETE' })}
                        disabled={portfolioBusy}
                      >
                        הסר
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="portfolio-section">
        <div className="section-head compact">
          <h3>רשימת מעקב</h3>
          <p>מניות מעניינות שלא נקנו עדיין.</p>
        </div>

        <div className="results-wrapper">
          <table>
            <thead>
              <tr>
                <th>סימול</th>
                <th>חברה</th>
                <th>מחיר נוכחי</th>
                <th>שינוי יומי</th>
                <th>מקור נתונים</th>
                <th>הערה</th>
                <th>פעולה</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.watchlist.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty-state">רשימת המעקב עדיין ריקה.</td>
                </tr>
              ) : (
                portfolio.watchlist.map((item) => (
                  <tr key={item.id}>
                    <td>{item.ticker}</td>
                    <td>{item.companyName}</td>
                    <td>{formatCurrency(item.currentPrice)}</td>
                    <td>
                      <ValueTone value={item.dailyChange}>{formatPercent(item.dailyChange)}</ValueTone>
                    </td>
                    <td>
                      <span className={`source-badge ${sourceClassName(item.source)}`}>{sourceLabel(item.source)}</span>
                    </td>
                    <td>{item.note || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="table-action-button"
                        onClick={() => submitPortfolioRequest(`/api/portfolio/watchlist/${item.id}`, { method: 'DELETE' })}
                        disabled={portfolioBusy}
                      >
                        הסר
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
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

function SummaryCard({ label, value, caption, tone = 'default' }) {
  return (
    <div className={`summary-card ${tone !== 'default' ? `summary-card-${tone}` : ''}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      {caption ? <span className="summary-caption">{caption}</span> : null}
    </div>
  );
}

function ValueTone({ value, children }) {
  return <span className={`value-tone ${toneForNumber(value)}`}>{children}</span>;
}

function toneForNumber(value) {
  const numeric = Number(value || 0);

  if (numeric > 0) return 'positive';
  if (numeric < 0) return 'negative';
  return 'neutral';
}

function sourceClassName(source) {
  if (source === 'fmp' || source === 'finnhub') return 'live';
  if (source === 'fmp_partial' || source === 'finnhub_partial') return 'partial';
  return 'demo';
}

function sourceLabel(source) {
  if (source === 'fmp') return 'נתוני אמת (FMP)';
  if (source === 'fmp_partial') return 'נתונים חיים חלקיים (FMP)';
  if (source === 'finnhub') return 'נתוני אמת (Finnhub)';
  if (source === 'finnhub_partial') return 'נתונים חיים חלקיים (Finnhub)';
  return 'נתוני דמו';
}

function formatCurrency(value) {
  return currencyFormatter.format(Number(value || 0));
}

function formatPercent(value) {
  const numeric = Number(value || 0);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numberFormatter.format(numeric)}%`;
}

export default PortfolioSection;

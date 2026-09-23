const BASE_URL = 'https://data.sec.gov';
const TICKER_URL = 'https://www.sec.gov/files/company_tickers.json';
const USER_AGENT = process.env.SEC_USER_AGENT || 'TradeSense personal recommendation review contact@example.com';

let tickerMap = null;
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 150) await wait(150 - elapsed);
  lastRequestAt = Date.now();
}

async function fetchSec(url, label) {
  try {
    const slot = requestQueue.then(throttle);
    requestQueue = slot.catch(() => {});
    await slot;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`[sec] ${label} failed: HTTP ${response.status}`);
      return { ok: false, status: response.status, data: null };
    }
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    console.warn(`[sec] ${label} failed: ${error.message}`);
    return { ok: false, status: 0, data: null };
  }
}

async function loadTickerMap() {
  if (tickerMap) return tickerMap;
  const response = await fetchSec(TICKER_URL, 'tickerMap');
  const map = new Map();
  if (response.ok && response.data && typeof response.data === 'object') {
    for (const item of Object.values(response.data)) {
      if (item?.ticker && Number.isFinite(Number(item.cik_str))) {
        map.set(String(item.ticker).toUpperCase(), String(item.cik_str).padStart(10, '0'));
      }
    }
  }
  tickerMap = map;
  return tickerMap;
}

async function getCompanyFilingsMetadata({ symbol, from, to, forms = ['8-K', '10-Q', '10-K'], limit = 25 } = {}) {
  if (!symbol || !from || !to) {
    return { configured: true, cik: null, filings: null, errorKind: 'invalid_request' };
  }
  const map = await loadTickerMap();
  const cik = map.get(String(symbol).toUpperCase());
  if (!cik) return { configured: true, cik: null, filings: [], errorKind: 'unknown_identity' };

  const response = await fetchSec(`${BASE_URL}/submissions/CIK${cik}.json`, `submissions:${symbol}`);
  if (!response.ok) return { configured: true, cik, filings: null, errorKind: response.status === 429 ? 'rate_limited' : 'provider_error' };

  const recent = response.data?.filings?.recent || {};
  const rows = [];
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const accepted = recent.acceptanceDateTime || [];
  for (let index = 0; index < accepted.length; index += 1) {
    const acceptedAt = Date.parse(accepted[index]);
    const form = recent.form?.[index] || null;
    if (!Number.isFinite(acceptedAt) || acceptedAt < fromMs || acceptedAt > toMs || !forms.includes(form)) continue;
    const accessionNumber = recent.accessionNumber?.[index] || null;
    rows.push({
      provider: 'sec',
      symbol: String(symbol).toUpperCase(),
      cik,
      form,
      accessionNumber,
      filingDate: recent.filingDate?.[index] || null,
      acceptanceDateTime: new Date(acceptedAt).toISOString(),
      primaryDocument: recent.primaryDocument?.[index] || null,
      url: accessionNumber ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replace(/-/g, '')}/${recent.primaryDocument?.[index] || ''}` : null,
      firstSeenAt: new Date().toISOString(),
    });
  }
  rows.sort((left, right) => Date.parse(left.acceptanceDateTime) - Date.parse(right.acceptanceDateTime));
  return { configured: true, cik, filings: rows.slice(0, Math.min(100, Math.max(1, Number(limit) || 25))), errorKind: null };
}

module.exports = {
  getCompanyFilingsMetadata,
};

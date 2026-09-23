const alpaca = require("../src/providers/alpacaService");
const finnhub = require("../src/providers/finnhubService");
const sec = require("../src/providers/secService");

function classifyErrors(errors = []) {
  const kinds = new Set(errors.map((error) => error.kind));
  if (kinds.has("auth")) return "not_entitled_or_auth";
  if (kinds.has("rate_limit")) return "rate_limited";
  if ([...kinds].some((kind) => ["timeout", "network", "temporary"].includes(kind))) return "temporary";
  if (kinds.size) return [...kinds].join(",");
  return null;
}

async function main() {
  const symbols = (process.argv.find((arg) => arg.startsWith("--symbols="))?.split("=")[1] || "AAPL,MSFT")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const end = new Date(Date.now() - 20 * 60000).toISOString();
  const start = new Date(Date.now() - 7 * 86400000).toISOString();
  const report = {
    checkedAt: new Date().toISOString(),
    configured: { alpaca: alpaca.isConfigured(), finnhub: finnhub.isConfigured(), sec: true },
    symbols,
    endpoints: [],
    limitation: "Probe only checks adapter capability and coverage for a small recent historical window; it is not a profitability test.",
  };
  if (!alpaca.isConfigured()) {
    report.endpoints.push({ provider: "alpaca", configured: false, errorKind: "not_configured" });
  } else {
    for (const feed of ["iex", "sip"]) {
      const detail = await alpaca.getBarsDetailed({
        symbols,
        timeframe: "5Min",
        start,
        end,
        feed,
        adjustment: "split",
        now: Date.now(),
      });
      report.endpoints.push({
        provider: "alpaca",
        endpoint: "bars",
        feed,
        timeframe: "5Min",
        start,
        end,
        complete: detail.complete,
        errorKind: classifyErrors(detail.errors) || (symbols.every((symbol) => !(detail.bars.get(symbol)?.length)) ? "empty_coverage" : null),
        failedSymbols: detail.failedSymbols,
        counts: Object.fromEntries(symbols.map((symbol) => [symbol, detail.bars.get(symbol)?.length || 0])),
      });
    }
    const oneMinute = await alpaca.getBarsDetailed({ symbols, timeframe: "1Min", start, end, feed: "sip", adjustment: "split", now: Date.now() });
    report.endpoints.push({
      provider: "alpaca",
      endpoint: "bars",
      feed: "sip",
      timeframe: "1Min",
      start,
      end,
      complete: oneMinute.complete,
      errorKind: classifyErrors(oneMinute.errors) || (symbols.every((symbol) => !(oneMinute.bars.get(symbol)?.length)) ? "empty_coverage" : null),
      counts: Object.fromEntries(symbols.map((symbol) => [symbol, oneMinute.bars.get(symbol)?.length || 0])),
    });
    const quotes = await alpaca.getHistoricalQuotesDetailed({ symbols: symbols.slice(0, 1), start, end: new Date(Date.parse(start) + 10 * 60000).toISOString(), feed: "sip", limit: 100, pageBudget: 2, priority: "probe" });
    report.endpoints.push({
      provider: "alpaca",
      endpoint: "quotes",
      feed: "sip",
      start,
      end: new Date(Date.parse(start) + 10 * 60000).toISOString(),
      complete: quotes.complete,
      partial: quotes.partial,
      pages: quotes.pages,
      errorKind: classifyErrors(quotes.errors) || (quotes.coverage[symbols[0]]?.count ? null : "empty_coverage"),
      coverage: quotes.coverage,
    });
    const corporate = await alpaca.getCorporateActionsDetailed({ symbols: symbols.slice(0, 1), start: start.slice(0, 10), end: end.slice(0, 10), pageBudget: 2 });
    report.endpoints.push({
      provider: "alpaca",
      endpoint: "corporate_actions",
      start: start.slice(0, 10),
      end: end.slice(0, 10),
      complete: corporate.complete,
      partial: corporate.partial,
      count: corporate.actions.length,
      errorKind: classifyErrors(corporate.errors) || null,
    });
  }

  const newsFrom = new Date(Date.now() - 3 * 86400000).toISOString();
  const newsTo = new Date().toISOString();
  const news = await finnhub.getCompanyNewsMetadata({ symbol: symbols[0], from: newsFrom, to: newsTo, limit: 5 });
  report.endpoints.push({
    provider: "finnhub",
    endpoint: "company-news",
    configured: news.configured,
    start: newsFrom,
    end: newsTo,
    count: Array.isArray(news.items) ? news.items.length : null,
    errorKind: news.errorKind,
  });

  const filings = await sec.getCompanyFilingsMetadata({ symbol: symbols[0], from: new Date(Date.now() - 30 * 86400000).toISOString(), to: new Date().toISOString(), limit: 5 });
  report.endpoints.push({
    provider: "sec",
    endpoint: "submissions",
    configured: true,
    cikKnown: Boolean(filings.cik),
    count: Array.isArray(filings.filings) ? filings.filings.length : null,
    errorKind: filings.errorKind,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

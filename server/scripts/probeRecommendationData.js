const alpaca = require("../src/providers/alpacaService");

async function main() {
  const symbols = (process.argv.find((arg) => arg.startsWith("--symbols="))?.split("=")[1] || "AAPL,MSFT")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const end = new Date(Date.now() - 20 * 60000).toISOString();
  const start = new Date(Date.now() - 7 * 86400000).toISOString();
  const report = {
    checkedAt: new Date().toISOString(),
    configured: alpaca.isConfigured(),
    symbols,
    windows: [],
    limitation: "Probe only checks adapter capability and coverage for a small recent historical window; it is not a profitability test.",
  };
  if (!alpaca.isConfigured()) {
    report.blocked = "alpaca_credentials_missing";
    console.log(JSON.stringify(report, null, 2));
    return;
  }
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
    report.windows.push({
      feed,
      timeframe: "5Min",
      start,
      end,
      complete: detail.complete,
      failedSymbols: detail.failedSymbols,
      errors: detail.errors,
      counts: Object.fromEntries(symbols.map((symbol) => [symbol, detail.bars.get(symbol)?.length || 0])),
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

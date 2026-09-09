const selection = require("../src/autopilot/selection");
const market = require("../src/autopilot/market");

function iso(time) {
  return new Date(time).toISOString();
}

function syntheticInput() {
  const now = Date.parse("2026-09-09T15:00:00Z");
  const open = Date.parse("2026-09-09T13:30:00Z");
  const today = { date: market.nyDate(now), open, close: open + 23400000 };
  const calendar = Array.from({ length: 6 }, (_, index) => ({
    date: market.nyDate(open - (5 - index) * 86400000),
    open: open - (5 - index) * 86400000,
    close: open - (5 - index) * 86400000 + 23400000,
  }));
  const rows = Array.from({ length: 80 }, (_, index) => ({
    symbol: `CMP${index}`,
    companyName: `Comparison ${index}`,
    exchange: index % 2 ? "NYSE" : "NASDAQ",
    close: index % 17 === 0 ? 10 : 100,
    avgDollarVolume20d: 2_000_000 + index * 100_000,
    dailyFeed: "sip",
  }));
  const snapshots = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        dailyBar: {
          t: iso(now),
          o: index % 17 === 0 ? row.close * 1.04 : row.close,
          c: row.close * (1 + index / 10000),
          v: 1000 + index,
        },
        latestTrade: { p: row.close * (1 + index / 10000), t: iso(now) },
      },
    ]),
  );
  const dailyFeatures = new Map(
    rows.map((row, index) => [
      row.symbol,
      {
        features: {
          price: row.close,
          atr14: 2,
          ma200: index % 19 === 0 ? row.close - 1 : row.close + 1,
          rsi14: index % 19 === 0 ? 28 : 50,
          return5d: index % 19 === 0 ? -6 : 1,
        },
      },
    ]),
  );
  return { now, today, calendar, rows, snapshots, dailyFeatures };
}

function oldTop25(rows, snapshots, now, today) {
  return rows
    .map((row) => {
      const snapshot = snapshots.get(row.symbol);
      const sameDay = market.nyDate(Date.parse(snapshot?.dailyBar?.t || 0)) === today.date;
      return {
        symbol: row.symbol,
        activity: sameDay ? Number(snapshot?.dailyBar?.v) * Number(snapshot?.dailyBar?.c) : 0,
      };
    })
    .filter((row) => row.activity > 0)
    .sort((left, right) => right.activity - left.activity || left.symbol.localeCompare(right.symbol))
    .slice(0, 25);
}

function run() {
  const input = syntheticInput();
  const picked = selection.selectCandidates({
    ...input,
    activeStrategies: ["orb15", "gap_pullback", "vwap_reclaim", "reversal5"],
  });
  const old = oldTop25(input.rows, input.snapshots, input.now, input.today);
  const oldSymbols = new Set(old.map((item) => item.symbol));
  const selectedSymbols = new Set(picked.selected.map((item) => item.symbol));
  const outsideOld = [...selectedSymbols].filter((symbol) => !oldSymbols.has(symbol));

  console.log(
    JSON.stringify(
      {
        mode: "read-only synthetic comparison",
        oldTop25: old.length,
        newSelected: picked.selected.length,
        outsideOldTop25: outsideOld.length,
        outsideOldTop25Sample: outsideOld.slice(0, 10),
        listSizes: picked.diagnostics.listSizes,
        rotationCount: picked.diagnostics.rotationCount,
      },
      null,
      2,
    ),
  );
}

run();

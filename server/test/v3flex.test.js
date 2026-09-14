const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-flex-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
const store = require("../src/autopilot/store");
const tracking = require("../src/autopilot/tracking");
const strategy = require("../src/autopilot/strategies");
const USER = "flex-user";
const now = Date.parse("2026-09-08T14:00:00Z");
const iso = (value) => new Date(value).toISOString();
const signal = {
  id: "flex-signal",
  ticker: "TEST",
  strategy: "pullback2_v1",
  version: "1.0.0",
  entry: 100,
  maxEntry: 101,
  stop: 98,
  target: 104,
  createdAt: iso(now - 60_000),
  expiresAt: iso(now + 600_000),
  deadline: iso(now + 86_400_000),
  mode: "swing",
  sizing: { shares: 0.2 },
};
store.putUser(USER, "signal", signal.id, signal);
test.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("flexible fills preserve tiny and oversized lots with atomic request idempotency", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const first = tracking.personalEntry(USER, signal.id, { requestId, price: 100, shares: 0.00001, fees: 0 }, now);
  assert.equal(first.shares, 0.00001);
  assert.equal(tracking.personalEntry(USER, signal.id, { requestId, price: 100, shares: 0.00001, fees: 0 }, now).id, first.id);
  const second = tracking.personalEntry(USER, signal.id, {
    requestId: "22222222-2222-4222-8222-222222222222", price: 100, shares: 0.4, additionalLot: true,
  }, now);
  assert.equal(second.shares, 0.4);
  assert.equal(second.additionalLot, true);
  assert.throws(() => tracking.personalEntry(USER, signal.id, {
    requestId: "33333333-3333-4333-8333-333333333333", price: 110, shares: 0.1,
    trackingPlanMode: "signal",
  }, now), (error) => error.code === "plan_invalid");
  const priceOnly = tracking.personalEntry(USER, signal.id, {
    requestId: "44444444-4444-4444-8444-444444444444", price: 110, shares: 0.1, additionalLot: true,
  }, now);
  assert.equal(priceOnly.trackingPlanMode, "none");
  const updated = tracking.track(USER, priceOnly, [], { price: 111, at: iso(now + 1_000) }, now + 1_000);
  assert.equal(updated.status, "open");
  assert.equal(updated.lastPrice, 111);
  const closed = tracking.personalClose(USER, priceOnly.id, { price: 111, fees: 0 }, now + 2_000);
  assert.equal(closed.r, null);
  assert.equal(tracking.statistics(store.listUser(USER, "trade")).find((row) => row.source === "personal").rObservations, 0);
});

test("new strategy metadata is experimental and strategy evaluator can produce both swing plans", () => {
  const bars = [
    { t: iso(now), o: 100, h: 101, l: 99, c: 100, v: 100, vw: 100 },
    { t: iso(now + 300_000), o: 100, h: 103, l: 100, c: 102, v: 100, vw: 101 },
  ];
  const daily = {
    barCount: 200, avgDollarVolume20d: 30000000, previousClose1: 101,
    price: 100, atr14: 2, ma20: 101, ma50: 99, ma200: 90,
    previousClose2: 102, previousLow1: 98, previousLow2: 99, high20: 101,
  };
  const plans = strategy.evaluate({ daily, bars, asOf: now + 600_000, sessionOpen: now - 1200000, sessionClose: now + 23_400_000, rvol: null });
  assert.ok(plans.some((plan) => plan.strategy === "pullback2_v1"));
  assert.ok(plans.some((plan) => plan.strategy === "breakout20_v1"));
  for (const key of ["pullback2_v1", "breakout20_v1"]) {
    const item = strategy.STRATEGIES.find((row) => row.key === key);
    assert.equal(item.enabledByDefault, false);
    assert.equal(item.evidence, "experimental");
  }
});

test("daily checkpoint survives a failed later batch without retaining candle bodies", async (t) => {
  const history = require("../src/autopilot/history");
  const alpaca = require("../src/providers/alpacaService");
  const symbols = Array.from({length:26},(_,i)=>"RES"+String.fromCharCode(65+i));
  const bars = Array.from({length:30},(_,i)=>({t:iso(now-(31-i)*86400000),o:100,h:102,l:98,c:100,v:300000}));
  let calls=0;
  t.mock.method(alpaca,"getBarsDetailed",async ({symbols: group})=>{
    calls++;
    if(calls===2) throw Error("interrupted");
    return {bars:new Map(group.map(s=>[s,bars])),complete:true,failedSymbols:[],errors:[]};
  });
  await assert.rejects(history.ensureDailyFeatures(symbols,now),/interrupted/);
  store.close();
  const resumed=await history.ensureDailyFeatures(symbols,now);
  assert.equal(calls,3);
  assert.equal(resumed.cacheHits,25);
  assert.equal(resumed.features.size,26);
  for(const pack of resumed.features.values()) assert.equal(pack.bars,undefined);
  await history.ensureDailyFeatures(symbols,now);
  assert.equal(calls,3); // 30-bar history remains usable for day strategies.
});

test("swing gates enforce liquidity, consecutive declines and session-relative hours", () => {
  const daily={price:100,barCount:200,avgDollarVolume20d:30000000,atr14:2,
    ma20:101,ma50:99,ma200:90,previousClose1:101,previousClose2:102,
    previousLow1:98,previousLow2:99,high20:101};
  const bars=[{t:iso(now),o:100,h:101,l:99,c:100,v:100,vw:100},
    {t:iso(now+300000),o:100,h:103,l:100,c:102,v:100,vw:101}];
  const args={daily,bars,asOf:now+600000,sessionOpen:now-1200000,sessionClose:now+23400000};
  assert.equal(strategy.evaluate({...args,sessionOpen:now}).length,0);
  assert.equal(strategy.evaluate({...args,sessionClose:now+3600000}).length,0);
  assert.equal(strategy.evaluate({...args,daily:{...daily,avgDollarVolume20d:19999999}}).length,0);
  assert.equal(strategy.swingEligible("pullback2_v1",{...daily,previousClose1:99}),false);
  assert.equal(strategy.swingEligible("pullback2_v1",{...daily,ma200:110}),false);
  assert.equal(strategy.evaluate({...args,bars:[{...bars[0],t:iso(now-300000)},bars[1]]}).length,0);
});

test("same request id cannot be reused for another signal or overflowing notional", () => {
  store.putUser(USER,"signal","another",{...signal,id:"another",ticker:"ELSE"});
  const input={requestId:"55555555-5555-4555-8555-555555555555",price:100,shares:0.1,additionalLot:true};
  tracking.personalEntry(USER,signal.id,input,now);
  assert.throws(()=>tracking.personalEntry(USER,"another",input,now),e=>e.status===409);
  assert.throws(()=>tracking.personalEntry(USER,signal.id,{price:1e308,shares:1e308},now));
});

test("backtest ignores pre-entry stop hits and does not invent an incomplete time exit", () => {
  const {resolveExit}=require("../scripts/backtestV3Strategies");
  const plan={stop:98,target:104};
  const bars=[{t:iso(now-300000),o:100,l:90,h:105,c:100},
    {t:iso(now),o:100,l:99,h:102,c:101}];
  assert.equal(resolveExit(bars,now,now+600000,plan),null);
  assert.deepEqual(resolveExit(bars,now,now+300000,plan),{price:101,reason:"deadline"});
  assert.deepEqual(resolveExit([...bars,{t:iso(now+300000),o:95,l:94,h:105,c:100}],now,now+600000,plan),{price:95,reason:"stop"});
});

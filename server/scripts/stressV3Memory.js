#!/usr/bin/env node
// Isolated real engine scans with synthetic provider responses; no network or production DB.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-v3-stress-"));
process.env.AUTOPILOT_DB_PATH = path.join(root, "stress.sqlite");
process.env.MEMORY_DIAGNOSTICS = "false";
const store = require("../src/autopilot/store");
const history = require("../src/autopilot/history");
const alpaca = require("../src/providers/alpacaService");
const engine = require("../src/autopilot/engine");
const users = require("../src/autopilot/users");
const settings = require("../src/autopilot/settings");
const market = require("../src/autopilot/market");
const iso = value => new Date(value).toISOString();
const now = Date.parse("2026-09-14T15:00:00Z");
Date.now = () => now;
const calendar = Array.from({length: 30}, (_, i) => {
  const open = Date.parse("2026-09-14T13:30:00Z") - (24-i)*86400000;
  return {date: market.nyDate(open), open, close: open+23400000};
});
const today = calendar[24];
const symbols = Array.from({length:2000}, (_,i) => "T"+[Math.floor(i/676)%26,Math.floor(i/26)%26,i%26].map(x=>String.fromCharCode(65+x)).join(""));
const daily = Array.from({length:260},(_,i)=>({t:iso(today.open-(260-i)*86400000),o:100,h:102,l:98,c:100,v:300000}));
const bars = calendar.slice(5,25).flatMap(day=>Array.from({length:78},(_,i)=>({t:iso(day.open+i*300000),o:100,h:101,l:99,c:100,v:100,vw:100})));
const samples = [];
function sample(phase) { const m=process.memoryUsage(); samples.push({phase,...m}); }
const originalPut = store.put;
store.put = (...args) => { const result=originalPut(...args); sample("write"); return result; };
let dailyRequests=0;
alpaca.getBarsDetailed = async ({symbols: group,timeframe}) => {
  sample("provider");
  if(timeframe==="1Day") dailyRequests++;
  return {bars:new Map(group.map(s=>[s,(timeframe==="1Day"?daily:bars).map(b=>({...b}))])), complete:true, failedSymbols:[],errors:[]};
};
alpaca.getSnapshots = async ({symbols:group}) => new Map(group.map(s=>[s,{dailyBar:{t:iso(today.open),o:100,c:100,v:10000},latestTrade:{p:100,t:iso(now)}}]));
alpaca.openStream = () => ({readyState:1,close(){}});
async function main() {
 try {
  const user=users.session({code:"1234"});
  settings.save({fees:"free",strategies:["vwap_reclaim"]},user.userId);
  store.put("cache","v3-universe",{date:today.date,rows:symbols.map(symbol=>({symbol,close:100,exchange:"NASDAQ",avgDollarVolume20d:30000000})),diagnostics:{complete:true}});
  for(const symbol of symbols.slice(0,400)) store.put("history",history.cacheKey({symbol,feed:"iex",timeframe:"5Min"}),{symbol,feed:"iex",timeframe:"5Min",sessionDate:today.date,watermarkAt:iso(now),fetchedAt:iso(now),lastUsedAt:iso(now),bars});
  for(const symbol of symbols.slice(400,500)) store.put("history",history.cacheKey({symbol,feed:"sip",timeframe:"5Min"}),{symbol,feed:"sip",timeframe:"5Min",sessionDate:today.date,watermarkAt:iso(now),fetchedAt:iso(now),lastUsedAt:iso(now),bars});
    await engine.scan(now,calendar,today); // Cold bootstrap of all 2,000 daily features.
  const coldRequests=dailyRequests;
  const tails=[];
  for(let i=0;i<12;i++) {
    await engine.scan(now,calendar,today);
    const state=store.get("runtime","engine");
    if(state.diagnostics.evaluatedCount!==120) throw Error("Not a full 120-candidate scan");
    sample("scan:"+i); tails.push(process.memoryUsage().rss);
  }
  const peak=Math.max(...samples.map(s=>s.rss));
  const growth=tails.at(-1)-tails[0];
  const metadata=store.listMetadata("history").filter(r=>r.timeframe==="5Min");
  const iexRecords=metadata.filter(r=>r.feed==="iex").length, sipRecords=metadata.filter(r=>r.feed==="sip").length;
  const pass=peak<350*1024*1024 && growth<50*1024*1024 && dailyRequests===coldRequests && coldRequests===80 && metadata.length<=500 && sipRecords<=100 && iexRecords===400 && sipRecords===100;
  console.log(JSON.stringify({status:pass?"pass":"fail",coldDailyRequests:coldRequests,warmDailyRequests:dailyRequests-coldRequests,features:2000,intradayHistories:metadata.length,iexRecords,sipRecords,barsPerHistory:bars.length,warmScans:12,peakMB:peak/1024/1024,tailGrowthMB:growth/1024/1024,tailMB:tails.map(x=>x/1024/1024)},null,2));
  if(!pass) process.exitCode=1;
 } finally { engine.stop(); store.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

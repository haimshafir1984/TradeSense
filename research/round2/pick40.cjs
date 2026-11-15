const {fs,path}=require('./lib.cjs');const S=require('./stats.cjs');
const P1=/\b(raises?|raised|lifts?|lifted|boosts?|boosted|increases?|increased|hikes?|hiked)\b[^.]{0,80}\b(guidance|outlook|forecast)\b/i;
const P2=/\b(guidance|outlook|forecast)\b[^.]{0,40}\b(raised|boosted|lifted|increased)\b/i;
const EXCL=/(price target|\bPT\b|analyst|upgrade|downgrade|rating|initiates|maintains|reiterates)/i;
const all=[];for(const f of fs.readdirSync('data/news')){const d=f.slice(0,10);for(const a of JSON.parse(fs.readFileSync('data/news/'+f)))if(a.n<=2&&(P1.test(a.h)||P2.test(a.h))&&!EXCL.test(a.h))all.push({d,s:a.s.join(','),h:a.h});}
console.log('total matches',all.length);const r=S.rng('round2-1:precision');const used=new Set();const out=[];
while(out.length<Math.min(40,all.length)){const i=Math.floor(r()*all.length);if(used.has(i))continue;used.add(i);out.push(all[i]);}
out.forEach((x,i)=>console.log(i+1,x.d,x.s,'|',x.h));

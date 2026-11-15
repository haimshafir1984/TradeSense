// regular-hours compaction of Alpaca 5-minute bars: [date, i, o, h, l, c, v], i = candle index 0..77 (09:30..15:55 New York)
const { nyOffsetHours } = require('./lib.cjs');
function compact5(barsArr) {
  const out = [];
  for (const b of barsArr) {
    const key = b.t.slice(0, 10);
    const t = new Date(b.t);
    const minutes = t.getUTCHours() * 60 + t.getUTCMinutes() - nyOffsetHours(key) * 60;
    const i = (minutes - 570) / 5;
    if (i < 0 || i > 77 || !Number.isInteger(i)) continue;
    out.push([key, i, b.o, b.h, b.l, b.c, b.v]);
  }
  return out;
}
module.exports = { compact5 };

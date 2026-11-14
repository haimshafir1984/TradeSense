// Leveraged / inverse / exchange-traded funds are kept out of TRADING (they stay in the scan and the shadow labelling, tagged,
// so the two groups can be compared). Reasons (external review 2026-11-14, docs/ALPACA_UPGRADE_PLAN_2026-11-14.md):
// ranking by 20-day range picks a 2X fund mechanically (twice the volatility by construction), several funds on one stock
// are one doubled bet, and in the shadow sample they distort the comparisons. Measured: ~62% of real-trade losses.
//
// Classification is by the asset name only (Alpaca has no reliable "ETF" field that we know of).
//   strong words -> excluded from trading
//   weak words   -> only flagged for human review (a REIT or a bank can have "Trust" in its name)
const STRONG = [
  /\b[23]X\b/i, /\bdaily\b/i, /\bleverag/i, /\binverse\b/i, /\bETF\b/i, /\bETN\b/i, /\bultra(pro|short)\b/i, /\bultra\s+(pro|short)/i,
  /\bdirexion\b/i, /\bproshares\b/i, /\btradr\b/i, /\bdefiance\b/i, /\bgranite\s?shares\b/i, /\bleverage shares\b/i,
  /\broundhill\b/i, /\bvolatility shares\b/i, /\byieldmax\b/i, /\bt-rex\b/i, /\bgraniteshares\b/i,
];
const WEAK = [/\btrust\b/i, /\bbull\b/i, /\bbear\b/i, /\bultra\b/i, /\bfund\b/i];

function classify(name) {
  const text = String(name || "");
  const strong = STRONG.filter((re) => re.test(text)).map((re) => text.match(re)[0].toLowerCase());
  if (strong.length) return { fundLike: true, words: [...new Set(strong)], weak: [] };
  const weak = WEAK.filter((re) => re.test(text)).map((re) => text.match(re)[0].toLowerCase());
  return { fundLike: false, words: [], weak: [...new Set(weak)] };
}

module.exports = { classify };

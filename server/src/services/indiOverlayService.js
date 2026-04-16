const ACTIVE_STRATEGIES = new Set(['mark_minervini', 'ross_cameron']);

function assessIndiFit({ stock, strategy, opportunity, riskOverlay, marketRegime }) {
  if (!ACTIVE_STRATEGIES.has(strategy)) {
    return null;
  }

  const volumeRatio = stock.volumeRatio || (stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0);
  const priceNearHigh = stock.price_near_daily_high || 0;
  const highProximity = stock.highProximity || (stock.high_52w ? stock.price / stock.high_52w : 0);
  const reasons = [];
  let score = 0;

  if (strategy === 'mark_minervini') {
    if (volumeRatio >= 1.3) {
      score += 20;
      reasons.push('נפח מעל הממוצע');
    }
    if (highProximity >= 0.9) {
      score += 18;
      reasons.push('קרובה לאזור פריצה');
    }
    if (stock.price > stock.MA50) {
      score += 12;
      reasons.push('מעל ממוצע 50');
    }
    if ((opportunity?.successProbability || 0) >= 60) {
      score += 10;
      reasons.push('איכות סטאפ סבירה');
    }
  }

  if (strategy === 'ross_cameron') {
    if (Number(stock.daily_change || 0) >= 5) {
      score += 24;
      reasons.push('מומנטום יומי חזק');
    }
    if (volumeRatio >= 2) {
      score += 18;
      reasons.push('נפח חריג');
    }
    if (priceNearHigh >= 0.93) {
      score += 16;
      reasons.push('קרובה לגבוה היומי');
    }
    if (stock.market_cap <= 10000000000) {
      score += 8;
      reasons.push('שווי שוק מתאים למסחר מהיר');
    }
  }

  if (marketRegime?.strategyFit?.level === 'high') {
    score += 10;
    reasons.push('תנאי שוק תומכים');
  } else if (marketRegime?.strategyFit?.level === 'low') {
    score -= 12;
  }

  if ((riskOverlay?.score || 0) >= 4) {
    score -= 10;
  }

  const normalizedScore = clamp(Math.round(score), 0, 100);
  const label = mapLabel(normalizedScore);

  return {
    active: true,
    score: normalizedScore,
    label,
    shouldAct: normalizedScore >= 65,
    note: buildNote(label, reasons)
  };
}

function mapLabel(score) {
  if (score >= 80) {
    return 'חזקה';
  }

  if (score >= 65) {
    return 'כן';
  }

  if (score >= 45) {
    return 'מעקב';
  }

  return 'לא';
}

function buildNote(label, reasons) {
  if (!reasons.length) {
    return label === 'לא' ? 'לא מתקבלת כרגע התאמה טובה לסגנון המסחר של Indi.' : 'יש התאמה חלקית לסגנון המסחר של Indi.';
  }

  return reasons.slice(0, 2).join(' | ');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  assessIndiFit
};

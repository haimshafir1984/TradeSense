function enrichExplanation({
  stock,
  strategy,
  deterministicExplanation,
  dataQuality,
  confluence,
  riskOverlay
}) {
  return {
    whyItFits: buildWhyItFits(stock, strategy, deterministicExplanation, confluence),
    mainRisk: buildMainRisk(stock, dataQuality, riskOverlay),
    fitHorizon: buildFitHorizon(strategy),
    recommendationStyle: buildRecommendationStyle(confluence, riskOverlay)
  };
}

function buildWhyItFits(stock, strategy, deterministicExplanation, confluence) {
  const reasons = [];

  if (strategy === 'micha_stocks') {
    if (stock.price > stock.MA200) {
      reasons.push('המניה נסחרת מעל ממוצע 200 יום');
    }
    if (stock.price > stock.MA50) {
      reasons.push('ומציגה מבנה טכני חיובי גם מעל ממוצע 50 יום');
    }
  } else if (strategy === 'mark_minervini') {
    if (stock.high_52w && stock.price / stock.high_52w >= 0.9) {
      reasons.push('המניה קרובה לשיא 52 שבועות');
    }
    if (stock.volume > stock.average_volume_30d) {
      reasons.push('ומקבלת תמיכה של נפח מסחר מעל הממוצע');
    }
  } else if (strategy === 'ross_cameron') {
    if (stock.daily_change > 5) {
      reasons.push('המניה מציגה מומנטום יומי חזק');
    }
    if (stock.average_volume_30d && stock.volume / stock.average_volume_30d > 2) {
      reasons.push('עם נפח מסחר חריג ביחס לממוצע');
    }
  }

  if (confluence?.level === 'high') {
    reasons.push('וקיימת תמיכה מכמה סגנונות מסחר');
  } else if (confluence?.level === 'medium') {
    reasons.push('עם אישור חלקי מאסטרטגיה נוספת');
  }

  if (!reasons.length) {
    return deterministicExplanation;
  }

  return `${deterministicExplanation}. ${reasons.join(' ')}`;
}

function buildMainRisk(stock, dataQuality, riskOverlay) {
  if (dataQuality.level === 'low') {
    return 'רמת הביטחון בנתונים נמוכה יחסית ולכן יש לאמת את הנתונים לפני החלטה';
  }

  if (riskOverlay?.factors?.length) {
    return `הסיכון המרכזי הוא ${riskOverlay.factors[0]}`;
  }

  if (stock.volatility >= 0.05) {
    return 'רמת התנודתיות גבוהה ולכן מהלך המחיר עלול להיות חד ומהיר';
  }

  if (stock.high_52w && stock.price / stock.high_52w >= 0.97) {
    return 'המניה קרובה מאוד לשיא השנתי ולכן קיים סיכון למימוש קצר טווח';
  }

  if (stock.volume < stock.average_volume_30d) {
    return 'נפח המסחר נמוך מהממוצע ולכן האישור למהלך פחות חזק';
  }

  return 'יש לעקוב אחרי המשכיות המגמה והאם הנתונים ממשיכים לתמוך בתזה';
}

function buildFitHorizon(strategy) {
  if (strategy === 'micha_stocks') {
    return 'מתאים יותר למשקיעים לטווח ארוך';
  }

  if (strategy === 'mark_minervini') {
    return 'מתאים יותר למסחר לטווח קצר או swing';
  }

  return 'מתאים יותר למסחר יומי ולמעקב צמוד';
}

function buildRecommendationStyle(confluence, riskOverlay) {
  if (confluence?.level === 'high' && riskOverlay?.level === 'low') {
    return 'מועמד חזק יחסית לבחינה מעמיקה';
  }

  if (riskOverlay?.level === 'high') {
    return 'מתאים יותר למעקב זהיר בגלל רמת סיכון גבוהה';
  }

  if (confluence?.level === 'low') {
    return 'מתאים יותר כרעיון ממוקד אסטרטגיה ולא כהסכמה רחבה';
  }

  return 'מועמד סביר לבחינה נוספת בהתאם לאופי המסחר';
}

module.exports = {
  enrichExplanation
};

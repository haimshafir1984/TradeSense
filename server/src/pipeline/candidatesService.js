// Wires runScan's shortlist together with playbook evaluation, risk-tier filtering, regime
// blocking, and ledger logging into the actual /api/candidates response
// (docs/SPEC_V2_ARCHITECTURE.md §6/§10 phase 8). This is the file the route handler calls.
// Required as namespace objects, not destructured, for runScan/playbookStats specifically - tests
// monkey-patch runScanModule.runScan / playbookStats.getPlaybookStatus the same way the rest of
// this codebase mocks a required module's exports; a destructured reference would capture the
// original function at require-time and never see the patched one.
const runScanModule = require('./runScan');
const playbookStats = require('../ledger/playbookStats');
const { getPlaybook } = require('../playbooks/index');
const { getRiskTier, isMarketCapInRange } = require('../risk/riskTiers');
const { applyStatusMultiplier } = require('../risk/positionSizing');
const ledgerStore = require('../ledger/ledgerStore');

const REJECTED_SAMPLE_LIMIT = 25;

const STATUS_WARNINGS = {
  hypothesis: 'פלייבוק במצב "רעיון בלבד" - לא נבדק כלל. אין לסחור על בסיסו.',
  backtested: 'פלייבוק "נבדק היסטורית בלבד" - טרם נמדד קדימה. אין לסחור בכסף אמיתי.',
  provisional: 'פלייבוק "נמדד חלקית" - גודל הפוזיציה מוקטן לחצי לפי §5.8.'
  // 'active' carries no status warning.
};

function describeCatalyst(catalyst) {
  if (!catalyst || !catalyst.kind) {
    return 'לא זוהה קטליזטור';
  }
  if (catalyst.kind === 'earnings_surprise') {
    return `הפתעת רווחים ${catalyst.earningsSurprisePct?.toFixed?.(1) ?? catalyst.earningsSurprisePct}%, לפני ${catalyst.daysSinceEarnings} ימי מסחר`;
  }
  if (catalyst.kind === 'earnings_scheduled') {
    return 'דוח כספים מתוזמן בקרוב';
  }
  if (catalyst.kind === 'news_spike') {
    return `${catalyst.newsCount48h} כתבות חדשותיות ב-48 השעות האחרונות`;
  }
  if (catalyst.kind === 'gap_no_news') {
    return `גאפ של ${catalyst.premarketGapPct?.toFixed?.(1) ?? catalyst.premarketGapPct}% ללא קטליזטור מזוהה - אזהרה, לא איכות`;
  }
  return 'לא זוהה קטליזטור';
}

function buildCandidateWarnings({ status, requestedAccountRiskUsd, resolvedAccountRiskUsd }) {
  const warnings = [];
  const statusWarning = STATUS_WARNINGS[status];
  if (statusWarning) {
    warnings.push(statusWarning);
  }
  if (requestedAccountRiskUsd != null && resolvedAccountRiskUsd === null) {
    warnings.push('לא ניתן לחשב גודל פוזיציה - הפלייבוק אינו בר-מסחר בדרגתו הנוכחית.');
  }
  return warnings;
}

// Resolves and caches each playbook's live ledger-derived status once per call - avoids re-reading
// the whole ledger for every candidate that playbook produces.
async function resolveStatuses(playbooks) {
  const statusByKey = new Map();
  for (const playbook of playbooks) {
    const { status } = await playbookStats.getPlaybookStatus(playbook.key);
    statusByKey.set(playbook.key, status);
  }
  return statusByKey;
}

function emptyResponse({ generatedAt, exchange, riskTier, regime, diagnostics, warnings }) {
  return { generatedAt, exchange, riskTier, regime: regime || null, candidates: [], diagnostics, warnings };
}

async function getCandidates({ exchange = 'NASDAQ', riskTier = 'balanced', playbook: requestedPlaybookKey = null, accountRiskUsd = null } = {}) {
  const tier = getRiskTier(riskTier);
  const generatedAt = new Date().toISOString();

  if (!tier) {
    return emptyResponse({
      generatedAt,
      exchange,
      riskTier,
      regime: null,
      diagnostics: { stage: 'riskTier' },
      warnings: [`רמת סיכון לא מוכרת: ${riskTier}`]
    });
  }

  let tierPlaybookKeys = tier.playbooks;
  if (requestedPlaybookKey) {
    if (!tierPlaybookKeys.includes(requestedPlaybookKey)) {
      return emptyResponse({
        generatedAt,
        exchange,
        riskTier,
        regime: null,
        diagnostics: { stage: 'playbook' },
        warnings: [`פלייבוק ${requestedPlaybookKey} אינו זמין ברמת הסיכון ${riskTier}`]
      });
    }
    tierPlaybookKeys = [requestedPlaybookKey];
  }

  const playbooks = tierPlaybookKeys.map(getPlaybook).filter(Boolean);
  const scan = await runScanModule.runScan({ exchange });

  if (scan.diagnostics.stage) {
    // runScan already hit a dead end (no universe / nothing survived liquidity) - nothing further
    // to do, pass its diagnostics through as-is.
    return emptyResponse({ generatedAt, exchange, riskTier, regime: scan.regime, diagnostics: scan.diagnostics, warnings: scan.warnings });
  }

  if (scan.regime?.blockedTiers?.includes(riskTier)) {
    return emptyResponse({
      generatedAt,
      exchange,
      riskTier,
      regime: scan.regime,
      diagnostics: { stage: 'regime', afterSelection: scan.shortlist.length },
      warnings: [`רמת הסיכון "${tier.label}" חסומה כרגע לפי משטר השוק (${scan.regime.state})`]
    });
  }

  const statusByPlaybookKey = await resolveStatuses(playbooks);

  const candidates = [];
  const playbookRejections = [];
  const marketCapRejections = [];

  for (const stock of scan.shortlist) {
    if (!isMarketCapInRange(riskTier, stock.marketCap)) {
      marketCapRejections.push({ symbol: stock.symbol, reason: `שווי שוק מחוץ לטווח הרמה "${tier.label}"` });
      continue;
    }

    for (const playbook of playbooks) {
      const status = statusByPlaybookKey.get(playbook.key);
      const resolvedAccountRiskUsd = accountRiskUsd != null ? applyStatusMultiplier({ accountRiskUsd, playbookStatus: status }) : null;

      const result = playbook.evaluate(stock, { accountRiskUsd: resolvedAccountRiskUsd });
      if (!result.eligible) {
        playbookRejections.push({ symbol: stock.symbol, playbook: playbook.key, reason: result.reason });
        continue;
      }

      const candidate = {
        ticker: stock.symbol,
        companyName: stock.companyName,
        price: stock.price,
        playbook: { key: playbook.key, label: playbook.label, status },
        catalyst: stock.catalyst ? { kind: stock.catalyst.kind, confidence: stock.catalyst.confidence, detail: describeCatalyst(stock.catalyst) } : null,
        selection: { rvol: stock.rvol, rvolBasis: stock.rvolBasis },
        conviction: result.conviction,
        factors: result.factors,
        plan: result.plan,
        warnings: buildCandidateWarnings({ status, requestedAccountRiskUsd: accountRiskUsd, resolvedAccountRiskUsd })
      };
      candidates.push(candidate);

      // §5.7: every candidate actually shown gets logged automatically - this is the entire point
      // of the ledger, not an optional side effect.
      await ledgerStore.appendEntry({
        ticker: stock.symbol,
        playbook: playbook.key,
        riskTier,
        featuresAtDecision: stock,
        plan: result.plan,
        regimeAtDecision: scan.regime?.state || null,
        source: 'forward'
      });
    }
  }

  candidates.sort((left, right) => (right.conviction ?? 0) - (left.conviction ?? 0));

  return {
    generatedAt,
    exchange,
    riskTier,
    regime: scan.regime,
    candidates,
    diagnostics: {
      ...scan.diagnostics,
      marketCapRejectedSample: marketCapRejections.slice(0, REJECTED_SAMPLE_LIMIT),
      playbookRejectedSample: playbookRejections.slice(0, REJECTED_SAMPLE_LIMIT),
      afterPlaybooks: candidates.length
    },
    warnings: scan.warnings
  };
}

module.exports = {
  getCandidates,
  describeCatalyst,
  buildCandidateWarnings
};

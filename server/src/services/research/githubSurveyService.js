// Survey of public GitHub repositories that build stock-recommendation / trading systems.
//
// This is a MANUAL, one-off research CLI (like the anomaly miner in this same directory) - no
// route, no scheduler, nothing in the running app calls it. See docs/SPEC_GITHUB_SURVEY.md.
//
// What this deliberately is NOT: a recommendation to adopt anything, or a quality judgement. It
// reads GitHub *metadata only* (stars, topics, description, last push, license) - it never reads
// a single line of the surveyed code, so it cannot tell you whether a repo backtests honestly or
// is riddled with lookahead bias. Treat the output as "here is what exists and is maintained",
// which is the only claim the data supports.
//
// Two-stage by design: GitHub's repo search only matches name/description/topics (NOT READMEs),
// so a long descriptive query like "position sizing stop loss risk management" ANDs itself down
// to zero results. Instead we harvest broadly by topic, then classify locally.
const { setTimeout: sleep } = require('node:timers/promises');

const GITHUB_API = 'https://api.github.com/search/repositories';

// Unauthenticated GitHub *search* is limited to 10 requests/minute, authenticated to 30. Default
// to the safe spacing and let a token shorten it.
const DELAY_UNAUTHENTICATED_MS = 7000;
const DELAY_AUTHENTICATED_MS = 2500;

// Stage 1: broad harvest. Topic queries were measured (2026-08-12) to return 47-262 repos each,
// versus 0-6 for descriptive multi-word queries.
const HARVEST_QUERIES = [
  'topic:algorithmic-trading',
  'topic:quantitative-finance',
  'topic:trading-strategies',
  'topic:backtesting',
  'topic:stock-market',
  'topic:technical-analysis',
  'topic:quantitative-trading',
  'topic:trading-bot'
];

// Stage 2: local classification. Framed around the gaps identified for TradeSense, not around
// "trading" generally - the point of the survey is prior art for what this project is missing.
const GAPS = [
  {
    key: 'exit-and-risk',
    label: 'יציאה, סטופים וגודל פוזיציה',
    why: 'הפער הגדול ביותר: TradeSense מייצר דירוג, לא עסקה - אין בו חוק יציאה או גודל פוזיציה.'
  },
  {
    key: 'backtest-engine',
    label: 'מנועי backtest',
    why: 'בדיקה עם עלויות עסקה ו-slippage, במקום backtest ידני שהומצא לצורך ריצה בודדת.'
  },
  {
    key: 'factor-analysis',
    label: 'ניתוח איכות פקטור',
    why: 'השאלה שלא נשאלה: האם הציון שהמערכת מחשבת בכלל מנבא תשואה עתידית.'
  },
  {
    key: 'ml-signal',
    label: 'למידה מתוצאות (meta-labeling)',
    why: 'ללמוד מהתוצאות שנרשמו בפועל במקום להמציא עוד חוקים ידניים.'
  },
  {
    key: 'intraday',
    label: 'נתונים תוך-יומיים',
    why: 'כל המערכת עובדת על מחיר סגירה; בטווח קצר מחיר הכניסה בפתיחה הוא שקובע.'
  },
  {
    key: 'event-driven',
    label: 'מונע-אירועים / קטליזטורים',
    why: 'תנועות של 12%+ מונעות מקטליזטור (דוח, FDA, הנפקה) - סריקת מחיר היא תמיד מאוחרת.'
  },
  {
    key: 'regime',
    label: 'זיהוי משטר שוק',
    why: 'לדעת מתי לא לסחור - לרוב משפר תוחלת יותר מכל שיפור בדירוג.'
  },
  {
    key: 'screener',
    label: 'סורקים ומערכות המלצה',
    why: 'ההשוואה הישירה: איך אחרים בנו בדיוק את מה שכבר קיים כאן.'
  },
  {
    key: 'llm-agent',
    label: 'סוכני LLM למסחר',
    why: 'הקטגוריה שאליה שייך Vibe-Trading - כדי לדעת מה עוד קיים בכיוון הזה.'
  },
  {
    key: 'data-layer',
    label: 'שכבת נתונים',
    why: 'חלופות ל-Alpaca/FMP/Finnhub, כולל נתונים שהמערכת כרגע לא מושכת בכלל.'
  }
];

// Keyword -> gap tagging. Metadata-only, so this is a coarse hint for grouping the report, never
// a claim about what the code actually does.
const CATEGORY_KEYWORDS = {
  'exit-and-risk': ['position siz', 'stop loss', 'risk manag', 'kelly', 'drawdown', 'money manag', 'portfolio optimi'],
  'backtest-engine': ['backtest', 'backtrader', 'vectorbt', 'zipline', 'event driven engine', 'simulation'],
  'factor-analysis': ['factor', 'alphalens', 'quantitative research', 'alpha research', 'alpha factor'],
  'ml-signal': ['machine learning', 'deep learning', 'meta label', 'reinforcement learning', 'neural', 'prediction', 'predict'],
  intraday: ['intraday', 'minute', 'tick data', 'orderbook', 'order book', 'level 2', 'real time', 'realtime', 'high frequency'],
  'event-driven': ['earnings', 'news', 'sentiment', 'sec filing', 'edgar', '8 k', 'catalyst', 'fundamental'],
  regime: ['regime', 'market state', 'hidden markov', 'hmm'],
  screener: ['screener', 'scanner', 'stock picker', 'recommend', 'signal generat'],
  'llm-agent': ['llm', 'gpt', 'openai', 'agent', 'langchain'],
  'data-layer': ['market data', 'data api', 'yfinance', 'data provider', 'ohlcv', 'data feed', 'data source']
};

// GitHub topics are hyphenated slugs ("position-sizing", "market-regime") while descriptions use
// spaces, so normalize both to spaces before keyword matching - otherwise every topic-only match
// is silently missed.
function searchableText(repo) {
  return [repo.name, repo.description || '', ...(repo.topics || [])]
    .join(' ')
    .toLowerCase()
    .replace(/[-_]/g, ' ');
}

// Pure: returns every gap whose keywords appear in the repo's own metadata. Keywords go through
// the same hyphen normalization as the text, so "meta-label" matches "meta label" too.
function classifyRepository(repo) {
  const text = searchableText(repo);
  const categories = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword.replace(/[-_]/g, ' ')))) {
      categories.push(category);
    }
  }

  return categories;
}

function daysBetween(laterIso, earlierIso) {
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) {
    return null;
  }
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

// Pure: the honest caveats about a repo that are visible from metadata alone. These are the
// reasons NOT to trust something, deliberately surfaced rather than hidden - the same principle
// as the "patterns that failed holdout" table in the anomaly report.
function assessRepository(repo, { now = new Date().toISOString() } = {}) {
  const staleDays = daysBetween(now, repo.pushed_at);
  const flags = [];

  if (repo.archived) {
    flags.push('ארכיון - הפרויקט הוקפא');
  }
  if (staleDays !== null && staleDays > 365) {
    flags.push(`נטוש לכאורה (${staleDays} ימים ללא commit)`);
  }
  if (!repo.license) {
    flags.push('ללא רישיון - אסור לשימוש חוזר בקוד');
  }
  if ((repo.stargazers_count || 0) < 200) {
    flags.push('מעט כוכבים - כמעט ללא ביקורת עמיתים');
  }

  return {
    fullName: repo.full_name,
    url: repo.html_url,
    description: (repo.description || '').trim(),
    stars: repo.stargazers_count || 0,
    language: repo.language || '-',
    license: repo.license ? repo.license.spdx_id || repo.license.key : null,
    pushedAt: repo.pushed_at,
    staleDays,
    archived: Boolean(repo.archived),
    categories: classifyRepository(repo),
    flags
  };
}

// Pure: dedupe the harvested repos by full name and rank by stars.
function dedupeAndRank(repositoryLists) {
  const byFullName = new Map();

  for (const repositories of repositoryLists) {
    for (const repo of repositories) {
      if (!byFullName.has(repo.fullName)) {
        byFullName.set(repo.fullName, repo);
      }
    }
  }

  return [...byFullName.values()].sort((left, right) => right.stars - left.stars);
}

// Pure: all repos tagged with a given gap, most-starred first.
function repositoriesForGap(repositories, gapKey) {
  return repositories.filter((repo) => repo.categories.includes(gapKey));
}

async function searchRepositories(query, { token, minStars, pushedSince, perPage = 100 } = {}) {
  const qualified = `${query} stars:>=${minStars} pushed:>=${pushedSince}`;
  const url = `${GITHUB_API}?q=${encodeURIComponent(qualified)}&sort=stars&order=desc&per_page=${perPage}`;

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'TradeSense-research-survey' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    throw new Error(
      `GitHub rate limit hit (status ${response.status}, remaining=${remaining}). ` +
        'הגדר GITHUB_TOKEN ב-.env כדי להעלות את המכסה, או המתן דקה ונסה שוב.'
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub search failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  return (body.items || []).map((repo) => assessRepository(repo));
}

async function runSurvey({ minStars = 150, maxAgeDays = 540, token = process.env.GITHUB_TOKEN, onProgress } = {}) {
  const now = new Date();
  const pushedSince = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const delayMs = token ? DELAY_AUTHENTICATED_MS : DELAY_UNAUTHENTICATED_MS;

  const harvested = [];

  for (const [index, query] of HARVEST_QUERIES.entries()) {
    if (onProgress) {
      onProgress(`[${index + 1}/${HARVEST_QUERIES.length}] ${query}`);
    }

    const repositories = await searchRepositories(query, { token, minStars, pushedSince });
    harvested.push(repositories);

    if (onProgress) {
      onProgress(`    → ${repositories.length} repos`);
    }

    if (index < HARVEST_QUERIES.length - 1) {
      await sleep(delayMs);
    }
  }

  const repositories = dedupeAndRank(harvested);

  return {
    generatedAt: now.toISOString(),
    authenticated: Boolean(token),
    minStars,
    maxAgeDays,
    pushedSince,
    harvestQueries: HARVEST_QUERIES,
    gaps: GAPS,
    repositories
  };
}

function formatRepoRow(repo) {
  const license = repo.license || '—';
  const stale = repo.staleDays === null ? '—' : `${repo.staleDays}ד`;
  const flags = repo.flags.length ? repo.flags.join('; ') : '';
  const description = repo.description.replace(/\|/g, '\\|').slice(0, 120) || '—';

  return `| [${repo.fullName}](${repo.url}) | ${repo.stars} | ${repo.language} | ${license} | ${stale} | ${description} | ${flags} |`;
}

const TABLE_HEADER = ['| ריפו | ⭐ | שפה | רישיון | מאז commit | תיאור | דגלים |', '|---|---|---|---|---|---|---|'];

// Pure: renders the whole markdown report. Kept separate from runSurvey so the CLI owns all
// filesystem writes (same split as the anomaly miner).
function renderReport(survey) {
  const lines = [];

  lines.push('# סקר GitHub — מערכות המלצות מניות ומסחר');
  lines.push('');
  lines.push(`תאריך ריצה: ${survey.generatedAt}`);
  lines.push('מקור: `docs/SPEC_GITHUB_SURVEY.md` (נוצר אוטומטית ע"י `npm run research:github --workspace server` — נדרס בכל ריצה)');
  lines.push('');
  lines.push(
    '**זו אינה המלצה לאמץ שום דבר מהרשימה, ואינה חוות דעת על איכות קוד.** הסקר קורא **מטא-דאטה בלבד** ' +
      'מ-GitHub (כוכבים, תיאור, תגיות, commit אחרון, רישיון) — הוא לא קורא שורת קוד אחת, ולכן אינו יכול לדעת ' +
      'אם פרויקט כלשהו סובל מ-lookahead bias, אם ה-backtest שלו כן, או אם הוא בכלל עובד. ' +
      'הטענה היחידה שהנתונים תומכים בה היא "זה קיים, ומתוחזק/לא מתוחזק".'
  );
  lines.push('');

  lines.push('## 1. פרמטרי הריצה');
  lines.push('');
  lines.push(`- מינימום כוכבים: ${survey.minStars}`);
  lines.push(`- commit אחרון מאז: ${survey.pushedSince} (חלון של ${survey.maxAgeDays} ימים)`);
  lines.push(`- אימות מול GitHub: ${survey.authenticated ? 'עם token' : 'ללא token (מכסה נמוכה)'}`);
  lines.push(`- שאילתות קציר: ${survey.harvestQueries.length} (\`${survey.harvestQueries.join('`, `')}\`)`);
  lines.push(`- ריפוזיטוריז ייחודיים: ${survey.repositories.length}`);
  lines.push('');

  const flagged = survey.repositories.filter((repo) => repo.flags.length > 0).length;
  const noLicense = survey.repositories.filter((repo) => !repo.license).length;
  const unclassified = survey.repositories.filter((repo) => repo.categories.length === 0).length;

  lines.push('## 2. תמונת מצב כללית');
  lines.push('');
  lines.push(`- ${flagged} מתוך ${survey.repositories.length} ריפוזיטוריז נושאים לפחות דגל אזהרה אחד.`);
  lines.push(`- ${noLicense} ללא רישיון כלל — אסור לשימוש חוזר בקוד, גם אם הם נראים מעניינים.`);
  lines.push(`- ${unclassified} לא נכנסו לאף קטגוריה — לרוב בוטים גנריים או אוספי קוד ללא ייעוד ברור.`);
  lines.push('');

  lines.push('## 3. עשרת הגדולים (לפי כוכבים)');
  lines.push('');
  lines.push('מוצג כי זה מה שרוב האנשים ימצאו קודם — **לא** כי זה מה שהכי רלוונטי לנו.');
  lines.push('');
  lines.push(...TABLE_HEADER);
  for (const repo of survey.repositories.slice(0, 10)) {
    lines.push(formatRepoRow(repo));
  }
  lines.push('');

  lines.push('## 4. תוצאות לפי פער במערכת');
  lines.push('');
  lines.push('כל סעיף פותח ב**למה זה מעניין אותנו** — הסקר מסודר סביב מה שחסר ב-TradeSense, לא סביב "מסחר" באופן כללי.');
  lines.push('');

  for (const gap of survey.gaps) {
    const matches = repositoriesForGap(survey.repositories, gap.key);

    lines.push(`### ${gap.label} (${matches.length})`);
    lines.push('');
    lines.push(`**למה זה מעניין אותנו:** ${gap.why}`);
    lines.push('');

    if (matches.length === 0) {
      lines.push('(לא נמצאו תוצאות שעומדות בסף — כשלעצמו ממצא: אין כאן הרבה קוד פתוח מתוחזק.)');
      lines.push('');
      continue;
    }

    lines.push(...TABLE_HEADER);
    for (const repo of matches.slice(0, 10)) {
      lines.push(formatRepoRow(repo));
    }
    lines.push('');
  }

  lines.push('## 5. מגבלות — לקרוא לפני שמסיקים משהו');
  lines.push('');
  lines.push('1. **מטא-דאטה בלבד.** לא נקראה שורת קוד אחת. פרויקט עם 20,000 כוכבים יכול להיות backtest עם lookahead bias.');
  lines.push('2. **כוכבים ≠ איכות.** דירוג לפי כוכבים מודד פופולריות ותשומת לב תקשורתית, לא נכונות סטטיסטית.');
  lines.push('3. **הטיית שרידות הפוכה.** מי שבאמת מצא edge כמעט לעולם לא מפרסם אותו בקוד פתוח. מה שנמצא בסקר הוא, בהגדרה, מה שלא היה שווה מספיק כדי להסתיר.');
  lines.push('4. **הקציר תלוי בתגיות.** GitHub מחפש בשם/תיאור/תגיות בלבד (לא ב-README), ולכן פרויקט מצוין שלא תייג את עצמו נכון פשוט לא קיים בסקר הזה.');
  lines.push('5. **הסיווג הוא התאמת מילות מפתח.** שיוך לקטגוריה נעשה לפי מילים בתיאור, לא לפי מה שהקוד עושה — צפו לטעויות בשני הכיוונים.');
  lines.push('6. **תצלום רגע.** הדוח נדרס בכל ריצה ומייצג את היום שבו רץ בלבד.');
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  HARVEST_QUERIES,
  GAPS,
  classifyRepository,
  assessRepository,
  dedupeAndRank,
  repositoriesForGap,
  searchRepositories,
  runSurvey,
  renderReport
};

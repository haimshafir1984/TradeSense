const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRepository,
  assessRepository,
  dedupeAndRank,
  repositoriesForGap,
  renderReport,
  GAPS,
  HARVEST_QUERIES
} = require('../src/services/research/githubSurveyService');

function repoFixture(overrides = {}) {
  return {
    full_name: 'someone/thing',
    html_url: 'https://github.com/someone/thing',
    name: 'thing',
    description: 'A thing',
    topics: [],
    stargazers_count: 1000,
    language: 'Python',
    license: { spdx_id: 'MIT' },
    pushed_at: '2026-08-01T00:00:00Z',
    archived: false,
    ...overrides
  };
}

test('classifyRepository tags from name, description and topics', () => {
  const repo = repoFixture({
    name: 'vectorbt',
    description: 'Fast backtesting library',
    topics: ['position-sizing']
  });

  const categories = classifyRepository(repo);

  assert.ok(categories.includes('backtest-engine'));
  assert.ok(categories.includes('exit-and-risk'));
});

test('classifyRepository returns an empty list when nothing matches', () => {
  assert.deepEqual(classifyRepository(repoFixture({ name: 'blog', description: 'my website', topics: [] })), []);
});

test('assessRepository flags an archived repository', () => {
  const assessed = assessRepository(repoFixture({ archived: true }), { now: '2026-08-12T00:00:00Z' });

  assert.equal(assessed.archived, true);
  assert.ok(assessed.flags.some((flag) => flag.includes('ארכיון')));
});

test('assessRepository flags a repository with no commits for over a year', () => {
  const assessed = assessRepository(repoFixture({ pushed_at: '2024-01-01T00:00:00Z' }), {
    now: '2026-08-12T00:00:00Z'
  });

  assert.ok(assessed.staleDays > 365);
  assert.ok(assessed.flags.some((flag) => flag.includes('נטוש')));
});

test('assessRepository flags a missing license, since it blocks reuse', () => {
  const assessed = assessRepository(repoFixture({ license: null }), { now: '2026-08-12T00:00:00Z' });

  assert.equal(assessed.license, null);
  assert.ok(assessed.flags.some((flag) => flag.includes('רישיון')));
});

test('assessRepository leaves a healthy, well-starred, recently-pushed repository unflagged', () => {
  const assessed = assessRepository(repoFixture(), { now: '2026-08-12T00:00:00Z' });

  assert.deepEqual(assessed.flags, []);
  assert.equal(assessed.license, 'MIT');
  assert.equal(assessed.stars, 1000);
});

test('dedupeAndRank keeps one entry when the same repo is harvested by several queries', () => {
  const assessed = assessRepository(repoFixture());

  const ranked = dedupeAndRank([[assessed], [assessed]]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].fullName, 'someone/thing');
});

test('dedupeAndRank sorts by stars descending', () => {
  const small = assessRepository(repoFixture({ full_name: 'a/small', stargazers_count: 300 }));
  const big = assessRepository(repoFixture({ full_name: 'b/big', stargazers_count: 9000 }));

  const ranked = dedupeAndRank([[small, big]]);

  assert.deepEqual(
    ranked.map((repo) => repo.fullName),
    ['b/big', 'a/small']
  );
});

test('repositoriesForGap selects only repos classified into that gap', () => {
  const backtester = assessRepository(repoFixture({ full_name: 'a/bt', description: 'backtesting library' }));
  const unrelated = assessRepository(repoFixture({ full_name: 'b/blog', name: 'blog', description: 'my site' }));

  const matches = repositoriesForGap([backtester, unrelated], 'backtest-engine');

  assert.deepEqual(
    matches.map((repo) => repo.fullName),
    ['a/bt']
  );
});

test('renderReport states the metadata-only limitation and includes every gap section', () => {
  const assessed = assessRepository(repoFixture());
  const report = renderReport({
    generatedAt: '2026-08-12T00:00:00Z',
    authenticated: false,
    minStars: 150,
    maxAgeDays: 540,
    pushedSince: '2025-02-18',
    harvestQueries: HARVEST_QUERIES,
    gaps: GAPS,
    repositories: [assessed]
  });

  assert.match(report, /מטא-דאטה בלבד/);
  assert.match(report, /אינה המלצה/);
  for (const gap of GAPS) {
    assert.ok(report.includes(gap.label), `report should contain the "${gap.label}" section`);
  }
});

# Recommendation Review and Fast Momentum Validation

Date: 2026-09-19

This document records the implementation status for
`docs/SPEC_RECOMMENDATION_REVIEW_AND_FAST_MOMENTUM.md`.

## Implemented

- Added durable SQLite tables for recommendations, receipts, lifecycle events,
  evaluation jobs, evaluations, outbox records and review runs.
- Added durable metadata tables for market evidence, corporate-action checks,
  catalyst events, evaluation revisions and shadow candidates.
- Connected new V3 signal publication to the archive in the same local
  transaction that stores the existing user signal.
- Stored recommendations even when sizing is not feasible and independently of
  any personal purchase report or simulation entry.
- Added compact feature snapshots and provenance instead of copying full OHLCV
  arrays into each recommendation.
- Added experimental `fast_momentum_candidate` tagging for existing `orb15` and
  `gap_pullback` recommendations when RVOL is at least 2 and ATR percentage is
  at least 3%.
- Added a pure 5-minute-bar recommendation evaluator. It only fills at an
  observable eligible bar open after publication, separates no-fill from
  unresolved data, and marks same-bar stop/target ordering as ambiguous.
- Added a second historical-measurement evaluator path for SIP 1-minute bars and
  historical quotes. It records stock movement and quote-observed entry
  opportunity, but explicitly does not treat quotes as proof of an actual fill.
- Added fixed review horizons: `plan`, `d0`, `d1`, `d3`, `d5`.
- Added Alpaca adapters for historical quotes and corporate actions, Finnhub
  news metadata, and a small SEC EDGAR submissions adapter.
- Added source/catalyst separation between decision evidence and post-hoc
  explanation.
- Added compact shadow-candidate storage from scan reason codes so future
  feedback can measure selection bias without changing live selection.
- Added a background review path with SQL leases, retryable errors, idempotent
  evaluation keys and review-run records.
- Added paginated recommendation APIs:
  - `GET /api/autopilot/recommendations`
  - `GET /api/autopilot/recommendations/:id`
  - `GET /api/autopilot/recommendations/review-summary`
  - `GET /api/autopilot/recommendations/quality-report`
- Added a dashboard summary and recommendation-history table in the Results tab.
- Added a Results-tab data-quality panel that separates plan outcome from stock
  movement and discloses that SIP/quote evidence is retrospective.
- Added `npm run recommendations:probe-data --workspace server` to check actual
  Alpaca, Finnhub and SEC adapter availability for a small historical window.
- Added `npm run recommendations:stress --workspace server` for synthetic archive
  load checks without hitting Alpaca.

## Tests and Commands

Planned verification commands:

```powershell
npm test --workspace server
npm run build
npm run recommendations:stress --workspace server -- --count=100000
npm run recommendations:probe-data --workspace server -- --symbols=AAPL,MSFT
```

The Alpaca probe is a capability and coverage check only. It is not a
profitability test and it does not prove production readiness.

Latest local validation, 2026-09-23:

- `npm test --workspace server` passed: 330/330.
- `npm run build` passed.
- `npm run recommendations:stress --workspace server -- --count=100000`
  passed. Duration: 237,297ms. Peak process RSS reported by the script: 92MB.
  The fixture creates 5 review jobs per recommendation after the horizon
  expansion.
- First local sandbox probe returned `fetch failed` for providers and was
  correctly classified as temporary/network, not blocked-data.
- Live probe with `.env` and network access passed for:
  - Alpaca IEX 5Min bars: AAPL=424, MSFT=395.
  - Alpaca SIP 5Min bars: AAPL=952, MSFT=942.
  - Alpaca SIP 1Min bars: AAPL=4108, MSFT=3893.
  - Alpaca SIP historical quotes: HTTP 200 with pagination; AAPL=200 quotes in
    2 pages, `partial=true` because the probe page budget intentionally stops
    early.
  - Alpaca corporate actions: HTTP 200, 0 actions for the short checked window.
  - Finnhub company-news metadata: 5 records returned in the checked sample.
  - SEC submissions: ticker-to-CIK lookup succeeded for AAPL; 0 recent filings
    in the checked sample window.
- Browser/API local check:
  - Login succeeded in a real browser at `http://localhost:5173`.
  - Results tab displayed the new data-quality panel and empty-state copy.
  - API session plus `recommendations`, `quality-report` and `review-summary`
    returned JSON for an authenticated user.
  - Unauthenticated `GET /api/autopilot/recommendations` returned 401.
  - Opening the UI at `127.0.0.1` showed a CORS failure because the configured
    `CLIENT_ORIGIN` is `http://localhost:5173`; opening at `localhost` matched
    the configured origin.

## Explicit Limits

- No profitability claim is made.
- The first evaluator uses 5-minute bars and cannot reconstruct quote-level
  execution quality.
- `d0/d1/d3/d5` are implemented as retrospective stock-movement horizons. They
  are not modeled trades and do not prove fill quality.
- The candidate-allocation experiment remains shadow-only. Active selection
  thresholds were not weakened.
- Live Alpaca availability depends on configured credentials and entitlements in
  the runtime environment.
- A 30-minute / million-receipt stress run was not completed in this local turn.
  The completed stress run covered 100,000 archived recommendations and 500,000
  review jobs. Do not call this production-ready until the longer environment
  load test, backup/restore drill and deployment scheduler checks are complete.

## Follow-up implementation validation, 2026-09-23

Implemented after `SPEC_FEEDBACK_MEASUREMENT_AND_LEARNING_IMPLEMENTATION_GPT55.md`:

- Added market-session horizon calculation for `d0/d1/d3/d5`; new jobs use
  cached Alpaca calendar sessions when available, and review evaluation resolves
  horizons from a historical calendar range instead of calendar-day offsets.
- Tightened stock-movement coverage: a single bar, internal gap or invalid
  reference is `needs_data`/retryable, not `complete`.
- Tightened historical quote sampling: only quotes inside the predefined
  30-second sampling window can become `quote_observed_entry_opportunity`; later
  quotes are marked `stale_quote`.
- Fixed catalyst classification so historical news/SEC items become
  `decision_evidence` only when both `eventAt` and measured `firstSeenAt` are at
  or before `decisionAt`; otherwise they remain `availability_unknown` or
  `post_hoc_explanation`.
- Added feedback tables and logic for versioned datasets, selection decisions,
  policy candidates/evaluations/activations, worker checkpoints and rollback
  audit.
- Added deterministic `feedback-simple-shadow-v1` policy in `shadow` by
  default. It can score candidates only inside an already eligible strategy
  list, and live reordering is applied only when a policy is explicitly in
  `active_limited`.
- Added a background recommendation review loop independent of market-open
  `tick`; it runs due jobs, builds a dataset and checks gates while leaving live
  selection on baseline/shadow unless gates and state allow limited activation.
- Added `/api/autopilot/recommendations/feedback-status` and a Results-tab panel
  showing policy state, dataset, coverage and gate status.
- Reworked `quality-report` to use one latest evaluation per
  recommendation/horizon, include jobs without evaluations, and keep pending or
  missing data in the denominator.

Validation commands:

```powershell
npm test --workspace server
npm run build
npm run recommendations:stress --workspace server -- --count=10000
npm run recommendations:probe-data --workspace server -- --symbols=AAPL,MSFT
```

Results:

- `npm test --workspace server` passed: 334/334.
- `npm run build` passed.
- Synthetic stress with 10,000 archived recommendation writes passed in
  10,503ms; reported RSS was 72MB.
- Local API check against a running server passed: session login, dashboard,
  `feedback-status`, `quality-report`, and unauthenticated recommendations
  returning 401. The feedback state was `shadow` with policy
  `feedback-simple-shadow-v1`.
- Provider probe ran through the existing adapters. In this local run Alpaca and
  Finnhub were `not_configured`; SEC was configured but ticker mapping failed
  with `fetch failed` and returned `unknown_identity`. This is a local
  availability limitation, not evidence that production lacks entitlement.

Not completed in this local validation:

- Real browser UI validation was attempted with Playwright CLI, but downloading
  `@playwright/cli` failed with local `EACCES`/npm-cache permissions. API and
  production build validation passed, but this run does not count as a real
  browser check.
- No live Alpaca/Finnhub entitlement probe was possible from this shell because
  credentials were unavailable to the probe command.
- No 30-minute / one-million-receipt stress test, backup/restore drill or
  deployment scheduler verification was run.
- The feedback policy remains `shadow_insufficient_evidence`/shadow by design
  until prospective gates are met. This is not a claim of improved
  recommendation accuracy or profitability.

## Feedback learning hardening, 2026-09-24

Implemented after `SPEC_FEEDBACK_LEARNING_AND_NEWS_VALIDATION_GPT55.md`:

- Replaced the compact feedback feature contract with `feedback-snapshot-v2`.
  New recommendation and shadow-candidate snapshots now carry decision time,
  feature availability time, lane, RVOL, gap, ATR%, ADV20, NY decision hour,
  price freshness, source versions and an explicit missing mask.
- Removed the unsafe live-learning fallback that treated strategy `score` as
  RVOL. Missing RVOL stays missing; legacy snapshots are marked
  `schema_incompatible` and are excluded from training.
- Made feedback datasets immutable for a given version/checksum. A later
  evaluation revision must create a new dataset version instead of silently
  rewriting rows.
- Tightened policy gates. Seven trading sessions are now only the minimum
  elapsed window. Activation also requires prospective resolved examples after
  shadow start, completed replay coverage and an explicit validation advantage.
  Old labels alone now keep the policy in `shadow_insufficient_evidence` with a
  named reason such as `prospective_evidence_insufficient`.
- Changed `no_observed_fill`, `ambiguous` and `unresolved` so they are not
  converted to numeric training losses. They remain denominator/quality
  outcomes, not fake returns.
- Made activation and rollback transactional. Activating a policy replaces any
  prior `active_limited` policy in the same transaction, records audit, and a
  partial unique index prevents two active limited policies.
- Added tests that prove old historical labels cannot promote a policy, a
  synthetic prospective v2 dataset can still exercise activation/rollback, and
  active ranking uses explicit RVOL instead of strategy score.

Validation commands for this hardening:

```powershell
npm test --workspace server -- --test-name-pattern feedback
npm test --workspace server
npm run build
npm run recommendations:stress --workspace server -- --count=10000
npm run recommendations:probe-data --workspace server -- --symbols=AAPL,MSFT
```

Result:

- `npm test --workspace server -- --test-name-pattern feedback` passed:
  336/336.
- `npm test --workspace server` passed: 336/336.
- `npm run build` passed.
- `npm run recommendations:stress --workspace server -- --count=10000`
  passed in 20,479ms. Reported RSS was 330MB. This is acceptable for the local
  smoke stress run but higher than earlier runs, so a longer environment load
  test is still required before calling the system production-ready.
- `npm run recommendations:probe-data --workspace server -- --symbols=AAPL,MSFT`
  ran through the adapters. In this local shell Alpaca and Finnhub were
  `not_configured`; SEC was configured but ticker mapping returned
  `fetch failed` and the probe surfaced `unknown_identity`. This is local
  availability/credential evidence only, not proof of missing production
  entitlement.
- Local API check against the running server passed: unauthenticated
  recommendations returned 401; session login returned 200; authenticated
  dashboard, `feedback-status`, `quality-report`, `review-summary` and
  recommendations returned 200. The feedback status was `shadow`.
- Browser check: Playwright CLI still failed with local npm-cache `EACCES` while
  trying to fetch `@playwright/cli`. The Codex in-app browser successfully
  loaded `http://localhost:5173`, opened the Results tab, and displayed the
  feedback panel with `shadow` status, policy version, dataset/gate text and no
  profit claim.

Limits:

- Replay and validation metrics are still represented as dataset evidence
  fields; this change blocks unsafe activation unless those fields are present,
  but it does not yet implement a complete real-pool replay engine.
- The system still must accumulate real prospective labels before any real
  learned policy should be trusted. Unit tests and synthetic activation do not
  prove improved accuracy, profitability or production readiness.
- The 30-minute / one-million-receipt stress test, backup/restore drill and
  deployment scheduler verification were not run in this local turn.

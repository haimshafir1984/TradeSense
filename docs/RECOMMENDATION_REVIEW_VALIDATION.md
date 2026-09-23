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

# Recommendation Review and Fast Momentum Validation

Date: 2026-09-19

This document records the implementation status for
`docs/SPEC_RECOMMENDATION_REVIEW_AND_FAST_MOMENTUM.md`.

## Implemented

- Added durable SQLite tables for recommendations, receipts, lifecycle events,
  evaluation jobs, evaluations, outbox records and review runs.
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
- Added a background review path with SQL leases, retryable errors, idempotent
  evaluation keys and review-run records.
- Added paginated recommendation APIs:
  - `GET /api/autopilot/recommendations`
  - `GET /api/autopilot/recommendations/:id`
  - `GET /api/autopilot/recommendations/review-summary`
- Added a dashboard summary and recommendation-history table in the Results tab.
- Added `npm run recommendations:probe-data --workspace server` to check actual
  Alpaca adapter availability for a small historical window.
- Added `npm run recommendations:stress --workspace server` for synthetic archive
  load checks without hitting Alpaca.

## Tests and Commands

Planned verification commands:

```powershell
npm test --workspace server
npm run build
npm run recommendations:stress --workspace server -- --count=10000
npm run recommendations:probe-data --workspace server -- --symbols=AAPL,MSFT
```

The Alpaca probe is a capability and coverage check only. It is not a
profitability test and it does not prove production readiness.

## Explicit Limits

- No profitability claim is made.
- The first evaluator uses 5-minute bars and cannot reconstruct quote-level
  execution quality.
- Only the initial `plan` horizon is implemented in the worker. Additional
  `d0/d1/d3/d5` stock-movement horizons still need expansion.
- The candidate-allocation experiment remains shadow/design-only. Active
  selection thresholds were not weakened.
- Live Alpaca availability depends on configured credentials and entitlements in
  the runtime environment.
- Browser verification and full 30-minute load testing must be run before
  calling this production-ready.

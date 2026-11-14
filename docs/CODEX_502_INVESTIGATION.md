# TradeSense: investigation brief for the intermittent 502 / event-loop stalls

Written 2026-11-04 for a second pair of eyes (Codex). Everything below marked **MEASURED** was observed on the
live production container; everything marked **HYPOTHESIS** is unverified. Please do not treat hypotheses as facts.

## 0. The task

Find the root cause of repeated, multi-second stalls of the single Node.js thread in production, and propose the
smallest safe fix. The user-visible symptoms are `502 Bad Gateway` from Traefik, an unresponsive website, and the
MT4 Expert Advisor logging `heartbeat returned HTTP 502`. These were already documented as an open issue in
`docs/SYSTEM_OVERVIEW.md` section 5 item 4 (2026-10-28), before any of the changes described in section 5 below.

Hard rules from the user (also in `CLAUDE.md`, read it first):

- Demo trading only. Never touch real-money behaviour. Do not change trading settings, entry/risk values or execution mode.
- Do not change the semantics of the MT4/Colmex path (`server/src/execution/*`, `mt4/*`). Additive or diagnostic changes only.
- Do not deploy and do not `git push`; the user pushes and deploys himself. Local commits are fine.
- Never print `.env` values, API keys or `EXECUTION_AGENT_TOKEN`.
- Tests: `node --test test/*.test.js` from `server/`, Node 24 required (`node:sqlite`). About 10 tests fail already and are unrelated (they leak state between runs); write new tests with a temp `AUTOPILOT_DB_PATH` and unique ids.
- Reply language for the user is Hebrew; code and comments stay English.

## 1. System in one page

- One Node 24 process: Express API + the autopilot scheduler + serves the built React client. SQLite via the
  **synchronous** `node:sqlite` `DatabaseSync` (`server/src/autopilot/store.js`), WAL mode, file `/data/autopilot.sqlite`.
  Generic key/value table `records(kind, id, body JSON text, metadata)` plus relational tables for recommendations/feedback.
- Deployed as a single Docker container (replica 1) via Dokploy/Docker Swarm behind Traefik, on a VPS that **also runs
  other production systems that must not be harmed** (about 60 containers: FlowsBiz, client systems, Postgres, Dokploy).
  Limits on the TradeSense service: memory 1.5 GiB, CPU currently 4 (was 2; see section 4). Host: 8 cores, about 23 GiB RAM.
- Scheduler (`server/src/autopilot/engine.js`): `tick()` every 30 s (`setInterval(tick, 30000)`), `reviewTick()` every 60 s.
  During US market hours `tick()` runs `scan()` about every 5 minutes (lease `scan`), `monitor()` for open positions, and
  recommendation review. `scan()` builds/uses a ~2,000 symbol universe, picks up to 120 symbols, fetches daily + intraday
  bars from Alpaca into the `history` cache (`server/src/autopilot/history.js`), evaluates 9 strategies
  (`strategies.js`), writes shadow/selection rows for a learning layer (`feedback.js`, `recommendations.js`).
- Execution layer (`server/src/execution/*`): an MT4 EA on a separate machine polls this server about every 15 s
  (`routes/execution.js`), posts heartbeat + positions + up to 300 closed deals (`execution/positions.js` ->
  `pnlHistory.record`, `outcomes.record`), receives queued orders. Server-side entry decisions in `execution/entryDecision.js`.
- Browser client (`client/src/App.jsx`): `load()` runs **every 15 s per open tab** and issues several requests:
  `/api/autopilot/dashboard`, `/api/execution/orders`, `/control`, `/positions`, `/close-requests`.
  `/dashboard` (`server/src/routes/autopilot.js`, `router.get("/dashboard"...)`) runs many synchronous queries
  (recommendations list/summary/quality report, feedback status, signals, trades, events).
- A new, independent Alpaca paper-trading arm exists in `server/src/alpaca-trader/` (see `docs/ALPACA_TRADER.md`). It is
  not the cause (section 4), but it is part of the process when `ALPACA_TRADER_ENABLED=true`.
- Key facts about data size: the production DB file was 958 MB before a VACUUM-compacted export of 322 MB (the learning
  tables had grown unbounded until `feedback.pruneHistory` was added on 2026-10-03; it runs at startup and after each dataset
  build). Row counts per table in production are **not yet measured**; see the commands in section 6.

## 2. The stall: what exactly is observed

`GET /api/health` is `app.get("/api/health", (_req,res)=>res.json({ok:true}))` in `server/src/app.js`: no I/O. If it
takes seconds, the single JS thread was blocked (or the process was starved of CPU).

**MEASURED, 2026-11-03 (market open):**

- Container death pattern: `Exited (137)` with `OOMKilled=false`. `docker inspect` health log of a killed container:
  `Status: unhealthy, FailingStreak: 3`, entries `Health check exceeded timeout (5s)` at 20:22:47, 20:23:53, 20:24:30, 20:25:06
  (one success at 20:23:23). The image HEALTHCHECK was `--timeout=5s --retries=3`, so Swarm killed a busy-but-alive container.
  Each restart repeats startup work (prune, universe checks), which probably made it worse.
- RSS near death was only 80 to 140 MB (periodic `[memory]` log lines and `docker stats`: 82 MiB / 1.5 GiB). One snapshot
  showed **CPU 110 %** (about one core) at a slow moment. So the stall looks CPU/synchronous-bound, not memory-bound.
- After loosening the healthcheck (`--health-timeout 30s --health-retries 10 --health-start-period 180s`, via
  `docker service update`): no more restarts and no 502s, but `/api/health` latency over 7 minutes (tabs open) was:
  23.3 s, 1.3, 17.3, 0.4, 19.9, timeout(25 s), 1.4, timeout, 5.4, timeout, 0.5, 15.5. Nine of twelve were slow or timed out.
- Quiet windows exist: five consecutive checks at 0.23 to 0.29 s earlier that afternoon.
- With all browser tabs closed, market hours (only four valid samples): 9.5 s, 0.7, 0.26, 0.37.
- Off-hours, next morning (about 06:00 UTC, US market closed, tabs presumably closed), seven valid samples: six at
  0.24 to 0.43 s and **one at 13.4 s**. So a background task also stalls the loop outside market hours, just much less often.

## 3. What has been ruled out (with the evidence)

| Candidate | Evidence |
|---|---|
| Out of memory | `OOMKilled=false`, RSS 80 to 140 MB at death, container at 5 % of the limit. |
| The new Alpaca engine | Stalls persisted with `ALPACA_TRADER_ENABLED=false` (verified in `docker service inspect`). The engine was also a no-op (a `NaN` market-hours bug meant it never scanned) until commit 18cc55e. |
| CPU limit too low | Stalls looked the same at 2 CPUs and at 4 CPUs. Node's main thread is about one core. |
| Disk full | Fixed earlier (2026-10-03); the prune/volume work is in place. |

## 4. Hypotheses, most to least likely (all unverified)

1. **Heavy synchronous SQLite + JSON work on the main thread.** `node:sqlite` is synchronous, and `store.list(kind)`
   parses the JSON body of every row. Candidates: `history` cache writes of large bar arrays (26-day intraday window,
   `INTRADAY_WINDOW_MS` in `history.js`), `store.list`/`listIds` on large kinds (`scanAttempt` is capped at 60,000 rows and
   is listed and pruned every scan in `engine.js`), `feedback.buildDataset` (`SELECT * FROM shadow_candidates`, JSON-parses
   and hashes every row), `recommendations`/`quality report` queries used by `/dashboard`.
2. **The dashboard endpoint under polling.** Every open tab calls `/dashboard` + four execution endpoints every 15 s. A slow
   `/dashboard` blocks everything else, including `/api/health`.
3. **EA heartbeat processing every 15 s** (`positions.save` with up to 300 closed deals, `pnlHistory`, `outcomes`).
4. **Scan phases**: universe rebuild (about 7,900 assets in batches), `ensureDailyFeatures`, selection and evaluation loops,
   `JSON.stringify` of big objects, plus `logMemory`.
5. **SQLite housekeeping**: WAL growth/checkpoint stalls, `BEGIN IMMEDIATE` contention in `store.lease`, bind-mount I/O
   (`/var/lib/tradesense` mounted at `/data`).
6. Garbage-collection pauses with a large heap (heapTotal was only 20 to 50 MB in logs, so unlikely).

## 5. What has changed recently (context, in case it matters)

- 2026-10-03: moved from Render to Dokploy; added `Dockerfile` with HEALTHCHECK (`timeout=5s, retries=3`); memory limit
  1.5 GiB and CPU limit 2 were applied later by `docker service update`.
- The brother (second developer on the same repo) added the MT4 execution system, premarket and sentiment logging,
  catalyst lookups, decision feed and UI changes between 2026-10-08 and 2026-10-28.
- 2026-11-03: Alpaca arm added and enabled (inert due to the NaN bug), CPU raised 2 to 4 as an experiment (did not help),
  healthcheck loosened at runtime.
- Local commits **not yet pushed**: `18cc55e` (fixes the NaN market-hours bug, which would make the Alpaca arm really scan
  about 150 symbols: more load) and `ec5abd5` (Dockerfile healthcheck `--timeout=30s --start-period=180s --retries=10`).
  Production currently runs the image of commit `1b5f582` with the healthcheck overridden on the service.

## 6. How to measure (production access is held by the user; ask him to run and paste)

```bash
# service-level facts
docker service inspect tradesense-tradesense-3pkcvj --format '{{json .Spec.TaskTemplate.Resources}}'
docker stats --no-stream $(docker ps -q --filter name=tradesense | head -1)
# did a task die of health failure or OOM
C=$(docker ps -aq --filter name=tradesense --filter status=exited | head -1); docker inspect $C --format 'OOMKilled={{.State.OOMKilled}} exit={{.State.ExitCode}}'; docker inspect $C --format '{{json .State.Health}}'
# DB size by record kind and by table (read-only)
docker exec $(docker ps -q --filter name=tradesense | head -1) node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/autopilot.sqlite',{readOnly:true});for(const r of d.prepare(\"select case when kind like 'user:%' then substr(kind, instr(substr(kind,6),':')+6) else kind end k, count(*) n, sum(length(body)) b from records group by k order by b desc limit 15\").all())console.log(String(r.k).padEnd(26),String(r.n).padStart(8),(r.b/1048576).toFixed(1)+' MB');for(const t of d.prepare(\"select name from sqlite_master where type='table' and name!='records'\").all()){const c=d.prepare('select count(*) c from '+t.name).get().c;if(c)console.log(t.name.padEnd(34),c)}"
# host contention (is anything else starving it, or is it starving others)
uptime; cat /proc/pressure/cpu; ls -la /var/lib/tradesense
```

Health probe used so far (24/7 safe, read-only):
`for i in $(seq 1 12); do curl -s -m 25 -o /dev/null -w "$(date -u +%T) %{http_code} %{time_total}s\n" https://trade.flowsbiz.com/api/health; sleep 15; done`

There is a built-in pause switch to isolate the scheduler from the HTTP layer: `POST /api/autopilot/system` with
`{"paused": true|false}` (header `X-TradeSense-User` + `Authorization: Bearer <profile code>`). While paused, `tick()` only
writes a heartbeat and `reviewTick()` returns early. It does not stop the HTTP routes or the EA endpoints. It affects live
(demo) trading behaviour, so only the user should decide to use it.

## 7. Suggested plan

1. **Instrument, do not guess.** Add an event-loop-lag monitor (`perf_hooks.monitorEventLoopDelay` plus a drift watchdog
   `setInterval`) that logs any stall over about 1 s with a label of what was running. Wrap the synchronous hot spots
   (`store.*`, `feedback.buildDataset`, `/dashboard` handler, `positions.save`, scan phases) with `performance.now()`
   timers and log anything over about 200 ms with the kind/SQL. Existing `logMemory("scan:...")` phase markers in
   `engine.js` already give a timeline to correlate with.
2. Use the DB measurements (section 6) to find unindexed or huge-result queries; check `EXPLAIN QUERY PLAN` for the
   dashboard and feedback queries.
3. Fixes to evaluate, smallest first: cache the `/dashboard` response for 10 to 15 s per user, trim or paginate its
   queries, lengthen the client poll interval, avoid `store.list(kind)` on big kinds (use SQL aggregates or ids), batch the
   `history` writes, chunk long synchronous loops with `setImmediate`, move heavy read-only work to a `worker_threads` worker
   with its own read connection, and serve `/api/health` from a tiny separate listener so liveness stays honest.
4. Add tests for anything changed, keep the full suite no worse than the baseline (about 10 known failures).

## 8. Open questions worth answering first

- Which kinds/tables dominate the 322 MB, and how many rows do the dashboard queries touch?
- Is there one long stall (a single sync call) or many medium ones adding up? The lag monitor will tell.
- Why does an off-hours stall of 13 s happen (which scheduled task runs then: universe prep, review, sentiment, premarket)?
- Did the stalls begin when the DB grew or when the brother's logging features were added (compare against git history)?

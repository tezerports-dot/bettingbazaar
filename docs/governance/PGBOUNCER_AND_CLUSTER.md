<!-- GOVERNANCE: Read CLAUDE.md before editing this file. -->
# PgBouncer, PostgreSQL tuning and the PM2 cluster

Configuration: `deploy/vps/docker-compose.prod.yml`, `deploy/vps/pgbouncer/pgbouncer.ini`,
`deploy/vps/postgres/postgresql.conf`, `ecosystem.config.cjs`.

## Layout (8 cores, 16 GB)

| Role | Processes | Notes |
|---|---|---|
| api | 4 PM2 cluster workers | HTTP API |
| realtime | 2 PM2 cluster workers | Socket.IO (websocket-only, no sticky sessions) and SSE |
| scheduler | 1 plain node process | cron and cycle engine, never clustered |
| migrate | one-shot | applies the schema under `pg_advisory_xact_lock`, then app roles start with `BB_SCHEMA_APPLY=skip` |

All roles join the Redis bridge (Socket.IO adapter and SSE relay), because the
scheduler and api produce events that the realtime role delivers.

## Sizing

7 Node processes x `PG_POOL_SIZE` 25 = at most 175 client connections, pooled by
PgBouncer (transaction mode) onto `default_pool_size` 30 (+10 reserve), never more
than `max_db_connections` 50. PostgreSQL `max_connections` 80 leaves headroom for
migrate, backups and operators. The memory budget is in `postgresql.conf`.

## Transaction-pooling compatibility (measured 2026-10-09, PostgreSQL 16 in the dev container)

- Advisory locks are transaction-scoped only; no session SET, LISTEN, temp tables or WITH HOLD.
- `npm run test:pgbouncer` (14 tests: pool mode, transactions, FOR UPDATE, advisory locks,
  prepared statements, SET LOCAL, a 500-client burst, static scans) passed 14/14.
- The whole `test:pg` money suite run through PgBouncer passed 1,693/1,693.
- CI job `pgbouncer` runs both on every push.

## Local cluster load test (dev container: 4 cores, not the production server)

4 api + 2 realtime workers + scheduler behind PgBouncer, `loadtest/cluster-load.mjs`,
150 s, 1,000 Socket.IO + 1,000 SSE clients, 100 HTTP loops, 500-connection spike:

- 2,000/2,000 realtime clients connected, 0 failures, 0 decode failures, 0 order violations.
- 4,212 req/s, p50 20.8 ms, p95 49.6 ms, p99 72.9 ms; event-loop p99 under 35 ms; worker RSS about 260 MB.
- The global `/api` limit (1,000 per 15 min per address) held across all four workers
  together, so the Redis rate-limit store is shared (every further `/api` request got 429).
- PgBouncer: 0 clients waiting; PostgreSQL backends stayed under the cap.
- That run found that the scheduler's events reached no client (the Redis bridge was
  only wired in the realtime role). Fixed in `server.js`; the re-run that confirms
  cross-role delivery was NOT completed in this session.

NOT verified here: worker kill / `pm2 reload` under load, PgBouncer and PostgreSQL
restarts under load, PostgreSQL 18, and anything on the real 8-core server.

## Owner's production load test (before launch)

1. Deploy the compose stack to the real server (or an identical staging box).
2. From a separate machine, run with your staging hostname:
   `BASE_URL=https://<api host> SOCKET_URL=https://<realtime host> SOCKETS=2000 SSE_CLIENTS=2000 HTTP_CONCURRENCY=200 DURATION=300 CONNECT_SPIKE=1000 METRICS_URLS=<per-worker /metrics URLs> METRICS_TOKEN=<token> node loadtest/cluster-load.mjs > result.json`
3. Check: `clientsThatSawAPhase` equals `clients`, 0 order violations, p95 under your SLO,
   `cl_waiting` near 0, no `bb_pg_connect_errors_total`, CPU below about 70% per core, RSS stable.
4. During the run: `docker compose exec api node_modules/.bin/pm2 reload all`, then
   `docker compose restart pgbouncer`, and confirm the app recovers with no 5xx burst.
5. Adjust `BB_WORKERS`, `PG_POOL_SIZE` and `default_pool_size` from what you measure.

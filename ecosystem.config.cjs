// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * PM2 process file — cluster mode for the HTTP and realtime roles.
 *
 * One app per container: the container's BB_RUNTIME_ROLE picks the role and
 * BB_WORKERS the worker count. deploy/vps/docker-compose.prod.yml runs
 *
 *   api        BB_WORKERS=4   pm2-runtime ecosystem.config.cjs
 *   realtime   BB_WORKERS=2   pm2-runtime ecosystem.config.cjs
 *   scheduler  plain `node backend/server.js` — EXACTLY ONE, never clustered
 *
 * = 6 backend workers on the 8-core server, leaving two cores for PostgreSQL,
 * PgBouncer, Redis, Caddy and the system (owner, 2026-10-09). Six is the
 * starting point, not a measured optimum: move the split with BB_WORKERS.
 *
 * Why it is safe to run several (CLAUDE.md §36): sessions are tokens checked
 * against PostgreSQL, rate limits use the Redis store, socket.io uses the
 * Redis adapter and SSE the Redis relay, cron and the cycle engine are
 * leader-locked and only run in the scheduler, wallet moves hold row locks.
 * Socket.io is websocket-only (server.js `transports: ['websocket']`), so the
 * cluster's round-robin needs no sticky sessions.
 *
 * Restarts and deploys:
 *   pm2 reload is rolling: `wait_ready` waits for the worker's
 *   process.send('ready') (sent once the database chain is up) before the next
 *   old worker is stopped. Stopping sends SIGINT; server.js fails readiness,
 *   drains for SHUTDOWN_DRAIN_MS, finishes in-flight requests and exits within
 *   SHUTDOWN_DEADLINE_MS (25 s), inside `kill_timeout`.
 */
const role = process.env.BB_RUNTIME_ROLE || 'all';
const workers = Math.max(1, Number.parseInt(process.env.BB_WORKERS || '1', 10) || 1);

if (role === 'scheduler' && workers > 1) {
  throw new Error('BB_RUNTIME_ROLE=scheduler must run exactly one process (BB_WORKERS=1)');
}

module.exports = {
  apps: [
    {
      name: `bb-${role}`,
      script: 'backend/server.js',
      instances: workers,
      exec_mode: workers > 1 ? 'cluster' : 'fork',

      // ─── Readiness and graceful stop ──────────────────────────────
      wait_ready: true,
      listen_timeout: 90_000,     // first boot may wait on the migrate step / Postgres
      kill_timeout: 30_000,       // > SHUTDOWN_DEADLINE_MS (25 s)
      shutdown_with_message: false,

      // ─── Automatic restart ────────────────────────────────────────
      autorestart: true,
      watch: false,
      max_memory_restart: process.env.BB_WORKER_MAX_MEMORY || '900M',
      exp_backoff_restart_delay: 200,   // 200 ms doubling to 15 s on a crash loop
      min_uptime: '20s',
      max_restarts: 50,

      // ─── Logging: stdout/stderr, collected by Docker ──────────────
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        BB_RUNTIME_ROLE: role,
      },
    },
  ],
};

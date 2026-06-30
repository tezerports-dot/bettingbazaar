/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚙️  PM2 ECOSYSTEM CONFIG — Anonymous VPS Deployment
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs        # start
 *   pm2 restart ecosystem.config.cjs      # restart all
 *   pm2 logs api                          # stream logs
 *   pm2 save && pm2 startup               # persist across reboots
 */

module.exports = {
  apps: [
    {
      // ✅ FIX #35: was 0 bytes — PM2 had nothing to start
      name: 'api',
      script: 'backend/server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',

      // ─── Clustering ───────────────────────────────────────────
      instances: process.env.PM2_INSTANCES || 1,   // set to 'max' for multi-core
      exec_mode: 'fork',                            // 'cluster' if instances > 1

      // ─── Auto-restart ─────────────────────────────────────────
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',

      // ─── Logging ──────────────────────────────────────────────
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // ─── Environment ──────────────────────────────────────────
      env: {
        NODE_ENV: 'development',
        PORT: 8080,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
    },
  ],
};

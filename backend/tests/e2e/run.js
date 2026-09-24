// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Boot the real server, drive every scenario against it over HTTP, tear it down.
 *
 * ── Why it boots the server rather than mounting a router ───────────────────
 * The point of this tier is everything a mounted router skips. A request here
 * goes through the same `helmet`, the same limiters, the same `authenticate`
 * and the same surge breakers a player's request does, because it IS the
 * process a player would be talking to (§28: a route test proves a handler
 * works and can never prove the stack in front of it lets the request reach
 * that handler).
 *
 * ── Tokens are minted, not obtained through the login screen ────────────────
 * Login is behind Cloudflare Turnstile. Minting the SAME payload the login
 * routes mint exercises every route, guard and middleware AFTER authentication
 * — which is where the behaviour under test lives — without pretending a
 * captcha was solved. What this therefore does NOT cover is the login screen
 * itself, and saying so is the point of §29.
 *
 * ── It writes to whatever DATABASE_URL names ────────────────────────────────
 * Scenarios seed their own actors with a per-run id and assert on deltas, not
 * on global invariants (trap 10). The one shared thing any of them touches is
 * `payment_mode_policies`, and the cash scenario restores the rail it found in
 * a `finally` — outside any assertion, because a restore that only runs when
 * the suite passed is the one that matters least.
 *
 *   npm run test:e2e            every scenario
 *   npm run test:e2e -- s1 s5   only those
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.DATABASE_URL) {
  console.error('test:e2e needs DATABASE_URL — it drives a real server against a real database.');
  process.exit(1);
}

/** Up to ~60s for the server to answer. A slow boot is not a failed one. */
async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/v1/system/config`);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// REFUSE TO RUN AGAINST A SERVER THIS RUNNER DID NOT START
// ══════════════════════════════════════════════════════════════════════════
// `waitForServer` below asks whether SOMETHING answers on the port. If a
// server is already there, the spawn below fails to bind, that question is
// answered YES by the incumbent, and the whole suite seeds into the database
// this process is connected to while asserting against whatever database the
// OTHER server is on.
//
// Measured, and it is not subtle in its consequences: a pristine database gave
// 26 failures reading "User not found. Token may be invalid." — every one of
// them true of the server being asked and false of the platform. `ss -tlnp`
// reports nothing for these listeners in this sandbox, so nothing else would
// have said so either.
//
// §32 S8: a gate measuring something other than what it claims. The fix is to
// ask BEFORE spawning, and to refuse rather than to guess.
try {
  const squatter = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
  if (squatter.ok) {
    console.error(
      `Something is ALREADY serving ${BASE}, so this run would measure it instead of\n`
      + `the server it is about to start — against a different database.\n\n`
      + `Stop it, or set E2E_PORT to a free port.`);
    process.exit(1);
  }
} catch { /* nothing there, which is what this run needs */ }

const server = spawn(process.execPath, [join(ROOT, 'backend', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

// The server is a child process; an exception here must not orphan it.
const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

let failed = 0;
try {
  if (!await waitForServer()) {
    console.error(`Server never answered on ${BASE}. Its output:\n${serverLog.join('').slice(-4000)}`);
    process.exit(1);
  }

  process.env.BB_BASE = BASE;
  const { summary } = await import('./harness.js');

  const only = process.argv.slice(2);
  const files = readdirSync(join(HERE, 'scenarios'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !only.length || only.some((o) => f.includes(o)))
    .sort();

  for (const f of files) {
    console.log(`\n${'━'.repeat(78)}\n${f}\n${'━'.repeat(78)}`);
    try {
      const mod = await import(join(HERE, 'scenarios', f));
      await mod.default();
    } catch (e) {
      // One scenario throwing must not hide the others: the next one is a
      // different rail, and a single bad row must not stop the report.
      console.log(`\n!! ${f} threw: ${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}`);
      failed += 1;
    }
  }
  failed += summary().failed;
} finally {
  stop();
}
process.exit(failed > 0 ? 1 : 0);

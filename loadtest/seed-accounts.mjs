// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * loadtest/seed-accounts.mjs — mint throwaway funded accounts for the load test.
 *
 * The bet-contention run needs many DISTINCT authenticated users. Distinct
 * matters: each user's wallet is its own document, so reusing one account
 * would measure per-wallet lock contention instead of the shared Cycle
 * document the test is actually about.
 *
 * Tokens are minted ONCE here and passed to k6, rather than logging in inside
 * the test. Login runs Argon2id at ~80 ms on a 4-thread libuv pool; folding
 * that into the run would swamp the bet latency being measured.
 *
 * STAGING ONLY. This creates real accounts and asks an admin to fund them.
 *
 *   BASE_URL=https://staging.example.com \
 *   ADMIN_MOBILE=9... ADMIN_PASSWORD=... \
 *   node loadtest/seed-accounts.mjs --count 40 --funds 5000
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const COUNT = Number(arg('count', 40));
const FUNDS = Number(arg('funds', 5000));
const PASSWORD = 'LoadTest!2026';

if (/\b(prod|production|www)\b/.test(BASE_URL)) {
  console.error(`Refusing to seed against what looks like production: ${BASE_URL}`);
  process.exit(1);
}

async function post(path, body, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, json };
}

// Mobile numbers must match /^[6-9]\d{9}$/ (the register validator). A fixed
// 79 prefix plus a timestamp slice keeps runs from colliding with each other.
const stamp = String(Date.now()).slice(-6);
const mobileFor = (i) => `79${stamp}${String(i).padStart(2, '0')}`.slice(0, 10);

const tokens = [];
const created = [];
let adminToken = null;

if (process.env.ADMIN_MOBILE && process.env.ADMIN_PASSWORD) {
  const r = await post('/api/v1/auth/login', {
    mobile: process.env.ADMIN_MOBILE, password: process.env.ADMIN_PASSWORD, loginType: 'admin',
  });
  if (r.json?.twoFactorRequired) {
    console.error('Admin has 2FA enabled — cannot seed unattended.');
    console.error('Either use an admin without 2FA on staging, or fund the accounts by hand.');
    process.exit(1);
  }
  adminToken = r.json?.token || null;
  if (!adminToken) console.warn(`⚠️  Admin login failed (${r.status}) — accounts will be created but NOT funded.`);
}

for (let i = 0; i < COUNT; i++) {
  const mobile = mobileFor(i);
  const r = await post('/api/v1/auth/register', {
    username: `lt${stamp}${i}`, mobile, password: PASSWORD,
  });
  if (!r.json?.token) {
    console.warn(`  register failed for ${mobile}: ${r.status} ${r.json?.message || ''}`);
    continue;
  }
  tokens.push(r.json.token);
  created.push({ mobile, userId: r.json.user?.id });

  if (adminToken && FUNDS > 0) {
    // Endpoint name varies by deployment; try the common admin credit route
    // and report rather than failing the whole seed.
    const f = await post('/api/admin/users/adjust-balance', {
      userId: r.json.user?.id, amount: FUNDS, type: 'DEPOSIT',
      reason: 'load-test seed',
    }, adminToken);
    if (f.status >= 400) {
      console.warn(`  funding failed for ${mobile}: ${f.status} ${f.json?.message || ''} — fund manually`);
    }
  }
}

console.log(`\nCreated ${tokens.length}/${COUNT} accounts (password: ${PASSWORD})`);
console.log(`Mobiles: ${created.map((c) => c.mobile).join(', ')}\n`);
console.log('Pass this to k6:\n');
console.log(`TOKENS=${tokens.join(',')}\n`);
if (!adminToken) {
  console.log('No admin credentials given — accounts are UNFUNDED. Set ADMIN_MOBILE/ADMIN_PASSWORD,');
  console.log('or credit them from the admin panel before running the load test.\n');
}

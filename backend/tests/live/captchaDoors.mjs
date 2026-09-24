// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which doors actually challenge, on a server where the captcha is switched on.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 * `captcha.test.js` covers the MIDDLEWARE — configured and not, accepted and
 * refused, Cloudflare unreachable, the header fallback, the IP it sends. All of
 * that is about whether `requireCaptcha` works. None of it asks whether it is
 * ON anything, which is §32 S32: the middleware is correct, every test is
 * green, and one of the doors has nothing in front of it.
 *
 * ── Why this is a LIVE probe and not a unit test ──────────────────────────
 * Two earlier drafts could not answer the question:
 *
 *   · Grepping the route files reported SEVEN naked doors, six of them false.
 *     `playerAuth.routes.js` spreads its captcha in from a shared chain
 *     (`...credentialChain('player-login')`), and the merchant login's captcha
 *     is a separate `app.use('/api/merchant/auth/login', …)` prefix mount in
 *     `server.js`. A text scan sees neither, and a gate that cries wolf six
 *     times out of seven is one somebody switches off (§28).
 *
 *   · Walking the router stack needs the assembled app, and `server.js` does
 *     not export it; `mountRouter` in the route harness mounts ONE router, so
 *     it cannot reproduce a prefix mount made in `server.js` either.
 *
 * What is unambiguous is what the door DOES. With a secret configured, a
 * request carrying no captcha token is refused 403 CAPTCHA_REQUIRED before the
 * handler — so this asks each door, on a running server, and believes the
 * answer.
 *
 * ── What this does NOT prove (§29) ────────────────────────────────────────
 * That a real Cloudflare challenge is solved end to end. That needs a live site
 * key, a live secret and a browser solving a real widget; there is no Turnstile
 * secret in this repository and there cannot be one. This proves which doors
 * challenge. The round trip to Cloudflare itself is untested, and nothing here
 * implies otherwise.
 *
 *   TURNSTILE_SECRET_KEY=<anything> node backend/server.js   # the server
 *   BB_CAPTCHA_BASE=http://127.0.0.1:8091 node backend/tests/live/captchaDoors.mjs
 */
const BASE = process.env.BB_CAPTCHA_BASE || 'http://127.0.0.1:8091';

const pass = [], fail = [], unprotected = [];
const ok = (name, cond, detail = '') => {
  (cond ? pass : fail).push(`${cond ? '✓' : '✗'} ${name}${detail ? `\n      ${detail}` : ''}`);
  return cond;
};

async function probe(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

/**
 * The doors, named explicitly rather than derived — and here that is right,
 * because the claim is "these five exist AND behave". A derived list that
 * quietly found four would pass while a door went unchecked.
 */
// ── A DISTINCT mobile per door, and a password that passes the policy ─────
// Both matter, and both were got wrong first:
//
//   · `loginPaceLimiter` is keyed on the mobile in the body (10s, max 1), so
//     five probes on ONE number answered 429 LOGIN_PACED before the captcha was
//     ever consulted — and this file reported four unprotected doors that were
//     in fact protected. Different numbers, no waiting, no false alarm.
//
//   · `'x'.repeat(14)` is one repeated run of characters and the password
//     policy refuses it by name. Reaching a PASSWORD check proves the captcha
//     did not run, but a refusal the probe caused itself proves nothing — the
//     input has to be one the door would otherwise accept.
const stamp = String(Date.now()).slice(-6);
const PW = `Cap7cha-Pr0be-${stamp}!`;
const DOORS = [
  ['player signup',   '/api/v1/auth/register',     { mobile: `91${stamp}1`.slice(0, 10), aadhaar: `2${stamp}00001`.slice(0, 12), password: PW, confirmPassword: PW }],
  ['player login',    '/api/v1/auth/login',        { mobile: `92${stamp}2`.slice(0, 10), password: PW }],
  ['staff login',     '/api/admin/login',          { mobile: `93${stamp}3`.slice(0, 10), password: PW }],
  ['merchant login',  '/api/merchant/auth/login',  { mobile: `94${stamp}4`.slice(0, 10), password: PW }],
  ['merchant signup', '/api/merchant/auth/signup', { username: `cap${stamp}`, mobile: `95${stamp}5`.slice(0, 10), email: `c${stamp}@example.test`, password: PW, acceptedCurrencies: ['INR'] }],
];

// ── Refuse to report on a server where the captcha is not even on ─────────
// §32 S33: a harness that measures something other than what it claims. With
// no secret configured `requireCaptcha` is a deliberate pass-through, so every
// door would answer "not challenged" and this file would report five holes
// that do not exist.
const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Start one with TURNSTILE_SECRET_KEY set.`);
  process.exit(1);
}
const control = await probe('/api/v1/auth/login',
  { mobile: `90${String(Date.now()).slice(-7)}`.slice(0, 10), password: 'Contro1-Probe-Pw!' });
if (control.body?.code !== 'CAPTCHA_REQUIRED') {
  console.error(
    'The player login did not challenge, so the captcha is NOT switched on for this server.\n'
    + 'Start it with TURNSTILE_SECRET_KEY set to any non-empty value — otherwise every door\n'
    + `below would read as unprotected and none of them would be.\n  got: ${control.status} `
    + `${JSON.stringify(control.body).slice(0, 160)}`);
  process.exit(1);
}

for (const [label, path, body] of DOORS) {
  const res = await probe(path, body);
  const challenged = res.body?.code === 'CAPTCHA_REQUIRED';
  if (!challenged) unprotected.push(`${label} — POST ${path} (${res.status})`);
  ok(`${label} challenges a request with no captcha token`, challenged,
     `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}

console.log(`\n${pass.join('\n')}`);
if (fail.length) console.log(`\nDOORS THAT DO NOT CHALLENGE:\n${fail.join('\n')}`);
console.log(`\n${pass.length} challenged, ${fail.length} did not\n`);
process.exit(fail.length ? 1 : 0);

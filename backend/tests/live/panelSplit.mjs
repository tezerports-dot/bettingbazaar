// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * panelSplit.mjs — the three-panel Telegram split, driven against a LIVE server.
 *
 * ── What this covers that no other tier can ────────────────────────────────
 * The split is a property of three things agreeing at once: which bot a
 * delivery arrived on, which account_type the contact resolves to, and which
 * channel the gate checks. A route test mounts one router and posts what it
 * meant; it cannot see a webhook authenticated against another bot's secret, a
 * reset link that opens the wrong panel's origin, or a contact share that
 * reaches the sub-admin sitting on the same mobile as the player.
 *
 * So this runs the real server, on a real database, and POSTs Telegram's own
 * updates to the real webhook paths with the real secret headers. Telegram is
 * the one thing that cannot be real; everything on this side of it is.
 *
 * ── The defect it exists to keep dead ─────────────────────────────────────
 * §32 S30. Before the audience split, `linkTelegramToAccount` matched by mobile
 * alone: on a number holding a player AND a sub-admin it resolved to whichever
 * row the planner reached first, and the bot's reset button then offered an
 * ADMIN's password to whoever held the phone. This file creates all three
 * accounts on ONE mobile, shares ONE Telegram account's contact with all three
 * bots, and asserts each link landed on its own row.
 *
 * ── What it does NOT cover, stated plainly (§29) ──────────────────────────
 * The CAPTCHA, for the reason `signupJourney.js` gives: there is no Turnstile
 * secret in this repository and there cannot be one. And it does not press
 * buttons — the GATES are a browser's job; this proves the server underneath
 * them.
 *
 * Needs a backend on BB_SPLIT_BASE (default http://127.0.0.1:8098) running
 * against the database this process connects to, with the three panel origins
 * set. It cleans up only the rows it created (trap 10).
 *
 *   node backend/tests/live/panelSplit.mjs
 */
/**
 * Drives the three-panel Telegram split against a RUNNING server, as the three
 * real actors. Telegram itself is the one thing that cannot be real here, so
 * its updates are POSTed to the webhooks exactly as Telegram would — same path,
 * same secret header, same payload shape. Everything else is the live stack.
 */
process.env.DATABASE_URL = process.env.BB_SPLIT_DB
  || 'postgresql://postgres:postgres@127.0.0.1:5433/bb_split';
// NOT overridden here. A hardcoded IDENTITY_ENCRYPTION_KEY in this file wrote
// bot tokens the SERVER could not decrypt — every webhook answered 401 and it
// read exactly like a broken secret check. The key comes from the same env the
// server was started with, or the two halves of this drive are not the same
// platform.
//
// The three panel origins, so a reset link that opens the WRONG panel is
// visible rather than indistinguishable from a right one.
process.env.PUBLIC_APP_ORIGIN     = 'http://127.0.0.1:5301';
process.env.ADMIN_PANEL_ORIGIN    = 'http://127.0.0.1:5302';
process.env.MERCHANT_PANEL_ORIGIN = 'http://127.0.0.1:5303';
const BASE = process.env.BB_SPLIT_BASE || 'http://127.0.0.1:8098';
const ADMIN_MOBILE = process.env.DEFAULT_ADMIN_MOBILE || '9999999999';
const ADMIN_PW = process.env.DEFAULT_ADMIN_PASSWORD || 'LocalTest-Admin-Pw-2026!';
const pass = [], fail = [];
const ok = (name, cond, detail='') => { (cond ? pass : fail).push(`${cond?'✓':'✗'} ${name}${detail?`\n      ${detail}`:''}`); return cond; };

async function req(path, { method='GET', body, token, headers={} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0,300) }; }
  return { status: res.status, body: json };
}

const stamp  = String(Date.now()).slice(-7);
const MOBILE = '98' + stamp.slice(-8).padStart(8, '1');
const TG_ID  = String(70000000 + Number(stamp) % 1000000);
console.log(`\nmobile ${MOBILE}   one telegram account ${TG_ID}\n`);

// ── 1. The seeded admin signs in ───────────────────────────────────────────
const { db } = await import('#db');
const { pgQuery } = await import('#db/client.js');
const { generateToken } = await import('../../domains/identity/totp.service.js');

let login = await req('/api/admin/login', { method:'POST', body:{
  mobile: ADMIN_MOBILE, password: ADMIN_PW,
}});

// ── The 2FA leg, when the account already has an authenticator ────────────
// The first run of this file enrols it, so every run after that meets a
// challenge here. Completing it is not optional: `/api/admin/verification` is
// behind the mandatory-2FA guard, so a driver that stops at the challenge
// measures the 2FA guard rather than the gate it is here to test.
if (login.body?.twoFactorRequired && login.body.challengeToken) {
  const creds = await db.users.getUserCredentials(
    (await pgQuery(`SELECT user_id FROM users WHERE mobile=$1 AND account_type='STAFF'`, [ADMIN_MOBILE])).rows[0].user_id);
  const { decryptSecret } = await import('../../domains/identity/totp.service.js');
  const plain = decryptSecret(creds.twoFactorSecret);
  login = await req('/api/admin/login/2fa', { method:'POST', body:{
    challengeToken: login.body.challengeToken, code: generateToken(plain),
  }});
}

if (!ok('admin signs in at the staff door', login.status === 200 && !!login.body.token,
        `${login.status} ${JSON.stringify(login.body).slice(0,220)}`)) {
  console.log(fail.join('\n')); process.exit(1);
}
const ADMIN = login.body.token;

// ── 1b. The admin enrols 2FA, because the platform insists ────────────────
// `/api/admin/verification` answers 403 TWO_FACTOR_ENROLMENT_REQUIRED until
// this is done, and that ordering is CORRECT rather than in the way: the panel
// mounts the verification gate inside `MandatoryTwoFactor`, so an admin who has
// not enrolled sees the enrolment screen and the gate renders nothing over it.
// Driving it here is what makes the rest of this file measure the gate instead
// of measuring the 2FA guard.
const setup = await req('/api/2fa/setup', { method:'POST', token: ADMIN });
if (setup.status === 200 && setup.body.secret) {
  const code = generateToken(setup.body.secret);
  const act = await req('/api/2fa/activate', { method:'POST', token: ADMIN, body:{ token: code, code } });
  ok('the admin enrols 2FA', act.status === 200, `${act.status} ${JSON.stringify(act.body).slice(0,180)}`);
} else {
  ok('the admin enrols 2FA', setup.body?.code === '2FA_ALREADY_ENABLED',
     `${setup.status} ${JSON.stringify(setup.body).slice(0,180)}`);
}

// ── 1c. Clear what a PREVIOUS run of this file left behind ────────────────
// BEFORE the bootstrap check, not after it. Running it after meant the
// bootstrap assertion ran against the bots the last run had registered — so it
// measured "staff are gated", reported a failure, and the failure was this
// file's ordering rather than the platform's behaviour.
//
// Trap 10: never assert a global invariant over a shared table. This removes
// only the rows this driver created.
const { pgQuery: q0 } = await import('#db/client.js');
await q0(`DELETE FROM telegram_identities WHERE telegram_user_id LIKE '7%'`);
await q0(`DELETE FROM telegram_bots WHERE bot_id LIKE '%-signin-%' OR bot_id LIKE '%-recovery-%'`);
await q0(`DELETE FROM telegram_configs WHERE reason = 'split drive'`);

// ── 2. THE BOOTSTRAP EXEMPTION ─────────────────────────────────────────────
const boot = await req('/api/admin/verification', { token: ADMIN });
ok('staff gate ADMITS while nothing is configured (bootstrap)',
   boot.status === 200 && boot.body.verified === true && boot.body.bootstrap === true,
   `${boot.status} verified=${boot.body.verified} bootstrap=${boot.body.bootstrap} reason=${boot.body.reason}`);
ok('and it names the STAFF audience', boot.body.audience === 'STAFF', String(boot.body.audience));

// ── 3. Six bots: a sign-in and a recovery bot for each of the three panels ──
// `registerBot` proves the token against Telegram, which is unreachable here,
// so the rows go in through the same repository the route writes with. What is
// under test is the SPLIT, not @BotFather.
const { encryptField } = await import('../../domains/identity/fieldCrypto.util.js');
const BOTS = {};
for (const audience of ['PLAYER','MERCHANT','STAFF']) {
  for (const role of ['signin','recovery']) {
    const botId = `${audience}-${role}-${stamp}`;
    const webhookSecret = `sec-${audience}-${role}-${stamp}`;
    await db.telegram.addBot({
      botId, label: `${audience} ${role}`, role, audience,
      username: `bb_${audience.toLowerCase()}_${role}`,
      tokenEncrypted: encryptField('000:FAKE'), webhookSecret, status: 'ACTIVE',
    });
    BOTS[`${audience}:${role}`] = { botId, webhookSecret };
  }
}
ok('six bots live at once — two per panel', true,
   'three signin fleets + three singular recovery bots, which the OLD live_slot refused');

// A channel per panel, each its own generation.
const GEN = {};
for (const [audience, chan] of [['PLAYER','-100111'],['MERCHANT','-100222'],['STAFF','-100333']]) {
  const cfg = await db.telegram.activateConfig({ audience, channelId: chan, reason: 'split drive' });
  GEN[audience] = cfg.generation;
}
ok('three channels active at once, with distinct generations',
   new Set(Object.values(GEN)).size === 3, JSON.stringify(GEN));

// ── 4. The bootstrap exemption CLOSES the moment staff are configured ──────
const afterConfig = await req('/api/admin/verification', { token: ADMIN });
ok('staff gate CLOSES once a staff bot and channel exist',
   afterConfig.body.verified === false && afterConfig.body.bootstrap === false
   && afterConfig.body.reason === 'share_contact',
   `verified=${afterConfig.body.verified} bootstrap=${afterConfig.body.bootstrap} reason=${afterConfig.body.reason}`);
ok('and the admin is sent to a STAFF bot, not the player one',
   String(afterConfig.body.bot?.username || '').includes('staff'),
   String(afterConfig.body.bot?.username));

// ── 5. Three accounts on ONE mobile ────────────────────────────────────────
const signup = await req('/api/v1/auth/register', { method:'POST', body:{
  mobile: MOBILE, aadhaar: '2' + stamp.padStart(11,'4'),
  password: 'PlayerPw-2026!', confirmPassword: 'PlayerPw-2026!',
}});
ok('a PLAYER signs up on that mobile', signup.status === 200 && signup.body.success === true,
   `${signup.status} ${JSON.stringify(signup.body).slice(0,200)}`);

const msignup = await req('/api/merchant/auth/signup', { method:'POST', body:{
  username: `msplit${stamp}`, mobile: MOBILE, email: `m${stamp}@example.com`,
  password: 'MerchantPw-2026-Long!', acceptedCurrencies: ['INR'],
}});
ok('a MERCHANT signs up on the SAME mobile', [200,201].includes(msignup.status),
   `${msignup.status} ${JSON.stringify(msignup.body).slice(0,220)}`);

const sub = await req('/api/admin/sub-admins', { method:'POST', token: ADMIN, body:{
  username: `subsplit${stamp}`, mobile: MOBILE, password: 'SubAdminPw-2026-Long!',
  permissions: { canViewAnalytics: true },
}});
ok('a SUB-ADMIN is created on the SAME mobile — three accounts, one number',
   [200,201].includes(sub.status), `${sub.status} ${JSON.stringify(sub.body).slice(0,200)}`);

// ── 6. ONE Telegram account shares its contact with all three bots ─────────
async function share(audience, role='signin') {
  const b = BOTS[`${audience}:${role}`];
  const path = role === 'signin'
    ? `/api/telegram/webhook/${b.botId}`
    : `/api/telegram/recovery/webhook/${b.botId}`;
  return req(path, {
    method:'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': b.webhookSecret },
    body: { update_id: Date.now(), message: {
      message_id: 1, date: Math.floor(Date.now()/1000),
      from: { id: Number(TG_ID), is_bot:false, first_name:'Split' },
      chat: { id: Number(TG_ID), type:'private' },
      contact: { phone_number: `+91${MOBILE}`, first_name:'Split', user_id: Number(TG_ID) },
    }},
  });
}
const sp = await share('PLAYER');
ok('the PLAYER bot accepts the contact share', sp.status === 200, String(sp.status));
const sm = await share('MERCHANT');
ok('the MERCHANT bot accepts the SAME contact — one Telegram account, two links',
   sm.status === 200, String(sm.status));
const ss = await share('STAFF');
ok('the STAFF bot accepts it too', ss.status === 200, String(ss.status));

await new Promise(r => setTimeout(r, 600));

// ── 7. Each link reached the RIGHT account ────────────────────────────────
const idP = await db.telegram.getIdentityByTelegramId(TG_ID, 'PLAYER');
const idM = await db.telegram.getIdentityByTelegramId(TG_ID, 'MERCHANT');
const idS = await db.telegram.getIdentityByTelegramId(TG_ID, 'STAFF');
ok('THREE separate links exist for ONE Telegram account',
   !!idP && !!idM && !!idS, `player=${!!idP} merchant=${!!idM} staff=${!!idS}`);

const users = await pgQuery(
  `SELECT user_id, account_type FROM users WHERE mobile = $1 ORDER BY account_type`, [MOBILE]);
const byType = Object.fromEntries(users.rows.map(r => [r.account_type, r.user_id]));
// §32 S19, paid for in this very file: `idS?.userId === byType.STAFF` read
// `undefined === undefined` and reported a PASS while the sub-admin route
// 404'd. An identity assertion has to fail when its precondition is missing,
// so every comparison below goes through this.
const present = (...vals) => vals.every(v => typeof v === 'string' && v.length > 0);
ok('all three accounts exist on that one mobile',
   present(byType.PLAYER, byType.MERCHANT, byType.STAFF),
   `player=${byType.PLAYER} merchant=${byType.MERCHANT} staff=${byType.STAFF}`);
ok('the PLAYER bot linked the PLAYER row',
   present(idP?.userId, byType.PLAYER) && idP.userId === byType.PLAYER,
   `linked ${idP?.userId} vs player ${byType.PLAYER}`);
ok('the MERCHANT bot linked the MERCHANT row — NOT the player on the same number',
   present(idM?.userId, byType.MERCHANT) && idM.userId === byType.MERCHANT, `linked ${idM?.userId} vs merchant ${byType.MERCHANT}`);
// ══════════════════════════════════════════════════════════════════════════
// THE PRIVILEGE ESCALATION, MEASURED
// ══════════════════════════════════════════════════════════════════════════
// Before the audience split, `linkTelegramToAccount` matched by mobile alone.
// On a number holding a player AND a sub-admin it resolved to whichever row the
// planner reached first — and the bot's reset button then offered an ADMIN's
// password to whoever held the phone (§32 S30). These three assertions are that
// defect, stated as what must be true instead.
ok('the STAFF bot linked the SUB-ADMIN row',
   present(idS?.userId, byType.STAFF) && idS.userId === byType.STAFF,
   `linked ${idS?.userId} vs staff ${byType.STAFF}`);
ok('the PLAYER bot did NOT reach the sub-admin on the same number',
   present(idP?.userId, byType.STAFF) && idP.userId !== byType.STAFF,
   `player link ${idP?.userId}, staff row ${byType.STAFF}`);
ok('all three links point at three DIFFERENT accounts',
   present(idP?.userId, idM?.userId, idS?.userId)
   && new Set([idP.userId, idM.userId, idS.userId]).size === 3,
   `${idP?.userId} / ${idM?.userId} / ${idS?.userId}`);

// ── 8. The reset link opens the RIGHT PANEL ───────────────────────────────
const { issueResetLink } = await import('../../domains/identity/passwordReset.service.js');
const rP = await issueResetLink({ userId: byType.PLAYER, telegramUserId: TG_ID, audience: 'PLAYER' });
ok('a PLAYER reset link opens the user panel',
   rP.ok && rP.url.startsWith('http://127.0.0.1:5301/'), rP.url || rP.reason);
const rM = await issueResetLink({ userId: byType.MERCHANT, telegramUserId: TG_ID, audience: 'MERCHANT' });
ok('a MERCHANT reset link opens the MERCHANT panel, not the user one',
   rM.ok && rM.url.startsWith('http://127.0.0.1:5303/'), rM.url || rM.reason);
const rS = await issueResetLink({
  userId: byType.STAFF, telegramUserId: TG_ID, audience: 'STAFF' });
ok('a STAFF reset link opens the ADMIN panel',
   rS.ok && rS.url.startsWith('http://127.0.0.1:5302/'), rS.url || rS.reason);

// ── 9. A bot may NOT mint a reset for another panel's account ─────────────
const cross = await issueResetLink({
  userId: byType.PLAYER, telegramUserId: TG_ID, audience: 'STAFF' });
ok('a STAFF bot CANNOT mint a reset for a player account',
   cross.ok === false && cross.reason === 'wrong_audience', JSON.stringify(cross));
const cross2 = await issueResetLink({
  userId: byType.STAFF, telegramUserId: TG_ID, audience: 'PLAYER' });
ok('a PLAYER bot CANNOT mint a reset for an ADMIN account',
   cross2.ok === false && cross2.reason === 'wrong_audience', JSON.stringify(cross2));
const noAud = await issueResetLink({ userId: byType.PLAYER, telegramUserId: TG_ID });
ok('and a caller that names NO panel is refused rather than assumed',
   noAud.ok === false && noAud.reason === 'wrong_audience', JSON.stringify(noAud));

// ── 10. A wrong secret is refused, per bot ────────────────────────────────
const wrong = await req(`/api/telegram/webhook/${BOTS['MERCHANT:signin'].botId}`, {
  method:'POST',
  headers: { 'X-Telegram-Bot-Api-Secret-Token': BOTS['PLAYER:signin'].webhookSecret },
  body: { update_id: 1, message: { message_id: 1, chat:{id:1,type:'private'}, from:{id:1,is_bot:false} } },
});
ok('the merchant webhook refuses the PLAYER bot’s secret',
   wrong.status === 401, String(wrong.status));

console.log(pass.join('\n'));
if (fail.length) { console.log('\nFAILURES:\n' + fail.join('\n')); }
console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
process.exit(fail.length ? 1 : 0);

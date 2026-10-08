// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 9: Step 3, through the Mini App, against the real server ────────
//
// Every other scenario MINTS its sessions (harness.js says why). This one
// earns them, the way a person does: a signup form, Telegram's Mini App
// verifying the mobile, a password sign-in, the staff and merchant approval in
// Telegram, Login with Telegram, and a forgotten password set in the Mini App
// (Step 3, owner 2026-10-07 and 2026-10-08).
//
// ── What stands in for Telegram ─────────────────────────────────────────────
// Telegram itself is never reached. The Mini App's signed strings are signed
// with the test bot's token (miniAppFixture.js), by the algorithm the server
// verifies, and that token is stored as the platform's one bot for the length
// of this scenario. So every request below is one the Mini App page could send;
// what is NOT covered is Telegram's own UI, and `requestContact` producing the
// signed string (checked against Telegram's documented format in miniAppAuth's
// unit tests only).
//
// Each request speaks from its own address (X-Forwarded-For; the runner starts
// the server with TRUST_PROXY=1): the doors pace one password try per mobile
// and the Telegram limiters key on the address, and this scenario is not here
// to measure either.
import { setTimeout as sleep } from 'node:timers/promises';
import { pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { hashPassword } from '../../../domains/identity/password.util.js';
import { tryVerifyPaseto } from '../../../domains/identity/paseto.util.js';
import { generateReferralCode } from '../../../domains/referral/referral.service.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId, TEST_BOT,
} from '../../miniAppFixture.js';
import { api, check, note, rid } from '../harness.js';

const A = 'TELEGRAM';
const PW = 'E2e-Step3-Pass-7q!';
const NEW_PW = 'E2e-Brand-New-Pass-4k!';

let addr = 0;
/** A fresh address per request, each in its own /24 (the subnet limiters count per /24). */
const from = () => { addr += 1; return `198.${18 + ((addr >> 8) & 1)}.${addr & 255}.9`; };
const call = (method, path, body, token) =>
  api(token ?? null, method, path, body, { 'X-Forwarded-For': from() });
const post = (path, body, token) => call('POST', path, body ?? {}, token);
const get = (path, token) => call('GET', path, undefined, token);

/** A ten-digit Indian mobile nobody has (first digit 6–9). */
const mobile = () => `9${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
const startParam = (telegram) => (telegram?.url ? new URL(telegram.url).searchParams.get('startapp') : null);
/** What a session proved, read from a token this runner can VERIFY (the server signs with the same key). */
const amrOf = (token) => tryVerifyPaseto(token)?.amr ?? null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The Mini App page answering the request it was opened on. */
const answer = (telegram, tgId, { decision = 'approve', phone = null } = {}) => post('/api/telegram/mini-app/approve', {
  initData: signInitData({ telegramUserId: tgId, startParam: startParam(telegram) }),
  ...(phone ? { contact: signContact({ telegramUserId: tgId, phone: `91${phone}` }) } : {}),
  decision,
});

const linkOf = async (userId) => (await pgQuery(
  'SELECT telegram_user_id, phone, two_factor FROM telegram_links WHERE user_id = $1', [userId])).rows[0] ?? null;
const earningsFrom = async (joinerId) => (await pgQuery(
  'SELECT count(*)::int AS n FROM referral_earnings WHERE source_user_id = $1', [joinerId])).rows[0].n;

export default async function run() {
  // A bot that is not the test bot belongs to whoever configured this
  // database: replacing it would break their deployment's Telegram.
  const { rows: before } = await pgQuery('SELECT bot_id FROM telegram_bot');
  if (before[0] && before[0].bot_id !== TEST_BOT.botId) {
    note(A, 'runner', 'Step 3 through the Mini App', 'the test bot', `bot ${before[0].bot_id} is configured`,
      'this database has a real bot saved; the scenario does not replace it');
    return;
  }
  await saveTestBot();
  await sleep(700); // the server's bot cache (TELEGRAM_CONFIG_TTL_MS, 500 ms in run.js)

  try {
    await playerSignupAndSignIn();
    await staffSignIn();
    await merchantSignupSignInAndReset();
  } finally {
    if (!before[0]) await removeTestBot();
  }
}

// ── A player: form signup, Mini App verification, every way to sign in ──────
async function playerSignupAndSignIn() {
  const referrer = rid('referrer');
  const code = generateReferralCode();
  await db.users.createUser({ userId: referrer, username: referrer, mobile: mobile(), referralCode: code });

  const m = mobile();
  const tgId = freshTelegramUserId();
  const signup = await post('/api/v1/auth/register', { mobile: m, password: PW, confirmPassword: PW, referralCode: code });
  check(A, 'player', 'sign up with the form and an invite code', '200, a Telegram step and no session',
    `${signup.status} token=${Boolean(signup.body.token)} telegram=${Boolean(signup.body.telegram?.url)}`,
    signup.status === 200 && !signup.body.token && Boolean(signup.body.challengeToken) && Boolean(startParam(signup.body.telegram)));
  const joiner = await db.users.getUserByMobile(m, 'PLAYER');
  check(A, 'player', 'the invite code is recorded, and pays nothing yet', `referred by ${referrer}; 0 earnings`,
    `${joiner?.referredBy}; ${joiner ? await earningsFrom(joiner.userId) : '?'} earnings`,
    joiner?.referredBy === referrer && (await earningsFrom(joiner.userId)) === 0);

  const early = await post('/api/v1/auth/login', { mobile: m, password: PW });
  check(A, 'player', 'sign in before verifying', '403 TELEGRAM_VERIFICATION_REQUIRED, with a Telegram step',
    `${early.status} ${early.body.code}`,
    early.status === 403 && early.body.code === 'TELEGRAM_VERIFICATION_REQUIRED' && Boolean(early.body.telegram?.url));

  const ctx = await post('/api/telegram/mini-app/context', {
    initData: signInitData({ telegramUserId: tgId, startParam: startParam(signup.body.telegram) }),
  });
  check(A, 'mini app', 'opened on the signup link', 'VERIFY, asks for the contact, hints the number',
    `${ctx.status} ${ctx.body.start?.kind} needsContact=${ctx.body.start?.needsContact} hint=${ctx.body.start?.mobileHint}`,
    ctx.status === 200 && ctx.body.start?.kind === 'VERIFY' && ctx.body.start?.needsContact === true
      && ctx.body.start?.mobileHint === `••••••${m.slice(-4)}` && !JSON.stringify(ctx.body).includes(m));

  const wrong = await answer(signup.body.telegram, tgId, { phone: mobile() });
  check(A, 'mini app', 'share a contact on another number', '403 CONTACT_MISMATCH, nothing linked',
    `${wrong.status} ${wrong.body.code}; link=${Boolean(await linkOf(joiner.userId))}`,
    wrong.status === 403 && wrong.body.code === 'CONTACT_MISMATCH' && !(await linkOf(joiner.userId)));

  const ok = await answer(signup.body.telegram, tgId, { phone: m });
  const link = await linkOf(joiner.userId);
  check(A, 'mini app', 'share the matching contact (+91 form)', '200 approved; linked to the ten-digit mobile',
    `${ok.status} approved=${ok.body.approved}; link phone=${link?.phone}`,
    ok.status === 200 && ok.body.approved === true && link?.phone === m && link?.telegram_user_id === tgId);
  check(A, 'player', 'the referrer is credited once the joiner is verified', '1 earning', `${await earningsFrom(joiner.userId)}`,
    (await earningsFrom(joiner.userId)) === 1);

  const session = await post('/api/v1/auth/login/2fa', { challengeToken: signup.body.challengeToken });
  check(A, 'player', 'the waiting signup page polls', '200 a session proved by password and Telegram',
    `${session.status} amr=${JSON.stringify(amrOf(session.body.token))}`,
    session.status === 200 && same(amrOf(session.body.token), ['pwd', 'tg']));
  const me = await get('/api/v1/auth/me', session.body.token);
  check(A, 'player', 'the session works', '200', `${me.status}`, me.status === 200);
  const again = await post('/api/v1/auth/login/2fa', { challengeToken: signup.body.challengeToken });
  check(A, 'attacker', 'redeem the same approval twice', 'refused', `${again.status} ${again.body.code}`,
    again.status >= 400 && !again.body.token);

  // ── Login with Telegram, from the website ──────────────────────────────
  const tl = await post('/api/v1/auth/login/telegram', {});
  check(A, 'player', 'Login with Telegram', '200 pending, with a Telegram step',
    `${tl.status} pending=${tl.body.pending}`, tl.status === 200 && tl.body.pending === true && Boolean(startParam(tl.body.telegram)));
  const waiting = await post('/api/v1/auth/login/telegram/complete', { challengeToken: tl.body.challengeToken });
  check(A, 'player', 'poll before approving', '202 TWO_FACTOR_PENDING', `${waiting.status} ${waiting.body.code}`,
    waiting.status === 202);
  const stranger = await answer(tl.body.telegram, freshTelegramUserId());
  const approved = await answer(tl.body.telegram, tgId);
  check(A, 'mini app', 'approve the Login with Telegram', 'a stranger is refused; the linked account approves',
    `${stranger.status} ${stranger.body.code}; ${approved.status} approved=${approved.body.approved}`,
    stranger.status >= 400 && approved.status === 200 && approved.body.approved === true);
  const tgSession = await post('/api/v1/auth/login/telegram/complete', { challengeToken: tl.body.challengeToken });
  check(A, 'player', 'the page completes the Telegram login', '200 a session proved by Telegram alone',
    `${tgSession.status} amr=${JSON.stringify(amrOf(tgSession.body.token))}`,
    tgSession.status === 200 && same(amrOf(tgSession.body.token), ['tg']));

  // The door paces one password try per mobile every 10 s (the early sign-in
  // above was one); wait it out rather than measure it (s8 measures it).
  await sleep(10_500);
  const pwd = await post('/api/v1/auth/login', { mobile: m, password: PW });
  check(A, 'player', 'sign in with the password, no Telegram', '200 a session (password alone)',
    `${pwd.status} amr=${JSON.stringify(amrOf(pwd.body.token))}`,
    pwd.status === 200 && same(amrOf(pwd.body.token), ['pwd']));

  // ── Forgot password, opened plainly in the Mini App ────────────────────
  const live = await get('/api/v1/auth/me', pwd.body.token);
  const reset = await post('/api/telegram/mini-app/password-reset', {
    initData: signInitData({ telegramUserId: tgId }), panel: 'PLAYER',
    contact: signContact({ telegramUserId: tgId, phone: `91${m}` }),
    password: NEW_PW, confirmPassword: NEW_PW,
  });
  const old = await get('/api/v1/auth/me', pwd.body.token);
  check(A, 'player', 'forgot password, set in the Mini App', '200 changed, no session; the old sessions are signed out',
    `${reset.status} changed=${reset.body.changed} token=${Boolean(reset.body.token)}; old session ${live.status} then ${old.status}`,
    reset.status === 200 && reset.body.changed === true && !reset.body.token && live.status === 200 && old.status === 401);
  await sleep(10_500);
  const fresh = await post('/api/v1/auth/login', { mobile: m, password: NEW_PW });
  check(A, 'player', 'sign in with the new password', '200', `${fresh.status}`, fresh.status === 200);
}

// ── Staff: the password, then the approval in Telegram ───────────────────────
async function staffSignIn() {
  const staff = async () => {
    const userId = rid('staff');
    const m = mobile().replace(/^9/, '8');
    await db.users.createUser({ userId, username: userId, mobile: m, passwordHash: await hashPassword(PW), accountType: 'STAFF', isAdmin: true });
    await db.users.setRoles(userId, ['admin']);
    return { userId, mobile: m, tgId: await linkTelegram(userId) };
  };

  const s = await staff();
  const first = await post('/api/admin/login', { mobile: s.mobile, password: PW });
  check(A, 'staff', 'sign in with the password, no captcha', '200 twoFactorRequired, with a Telegram step, no session',
    `${first.status} ${first.body.code ?? ''} twoFactorRequired=${first.body.twoFactorRequired} token=${Boolean(first.body.token)}`,
    first.status === 200 && first.body.twoFactorRequired === true && !first.body.token && Boolean(startParam(first.body.telegram)));
  const pending = await post('/api/admin/login/2fa', { challengeToken: first.body.challengeToken });
  check(A, 'staff', 'the login page polls before the approval', '202', `${pending.status}`, pending.status === 202);

  const stranger = await answer(first.body.telegram, freshTelegramUserId());
  check(A, 'attacker', "approve a staff sign-in from another Telegram account", 'refused', `${stranger.status} ${stranger.body.code}`,
    stranger.status >= 400);
  const ok = await answer(first.body.telegram, s.tgId);
  const session = await post('/api/admin/login/2fa', { challengeToken: first.body.challengeToken });
  check(A, 'staff', 'approve in Telegram, then the page polls', '200 a session proved by password and Telegram',
    `${ok.status}; ${session.status} amr=${JSON.stringify(amrOf(session.body.token))}`,
    ok.status === 200 && session.status === 200 && same(amrOf(session.body.token), ['pwd', 'tg']));
  const mine = await get('/api/admin/account/telegram', session.body.token);
  check(A, 'staff', 'the session opens a staff screen', '200', `${mine.status}`, mine.status === 200);

  const d = await staff();
  const second = await post('/api/admin/login', { mobile: d.mobile, password: PW });
  const denied = await answer(second.body.telegram, d.tgId, { decision: 'deny' });
  const refused = await post('/api/admin/login/2fa', { challengeToken: second.body.challengeToken });
  check(A, 'staff', 'deny a sign-in in Telegram', '401 TWO_FACTOR_DENIED, no session',
    `${denied.status}; ${refused.status} ${refused.body.code}`,
    denied.status === 200 && refused.status === 401 && refused.body.code === 'TWO_FACTOR_DENIED' && !refused.body.token);
}

// ── A merchant: form signup, sign-in, and a forgotten password ───────────────
async function merchantSignupSignInAndReset() {
  // Signup by form: no captcha (owner, 2026-10-08), then the Telegram step.
  const am = mobile().replace(/^9/, '7');
  const atg = freshTelegramUserId();
  const signup = await post('/api/merchant/auth/signup', { username: rid('mapp').replace(/-/g, ''), mobile: am, password: PW });
  check(A, 'merchant', 'apply with the form, no captcha', '200, a Telegram step',
    `${signup.status} ${signup.body.code ?? ''} telegram=${Boolean(signup.body.telegram?.url)}`,
    signup.status === 200 && Boolean(startParam(signup.body.telegram)));
  const verified = await answer(signup.body.telegram, atg, { phone: am });
  const applicant = await db.users.getUserByMobile(am, 'MERCHANT');
  const alink = applicant ? await linkOf(applicant.userId) : null;
  check(A, 'merchant', 'verify the mobile while the application waits', 'linked, with Telegram approval required',
    `${verified.status}; link two_factor=${alink?.two_factor}`, verified.status === 200 && alink?.two_factor === true);
  const waiting = await post('/api/merchant/auth/login', { mobile: am, password: PW });
  check(A, 'merchant', 'sign in before an admin approves', '403 MERCHANT_NOT_ACTIVE (worded), no session',
    `${waiting.status} ${waiting.body.code}`, waiting.status === 403 && waiting.body.code === 'MERCHANT_NOT_ACTIVE' && !waiting.body.token);

  // An approved merchant signs in.
  const m = mobile().replace(/^9/, '7');
  const created = await createMerchantAccount({
    userId: db.users.newUserId(), username: rid('m').replace(/-/g, ''), mobile: m,
    passwordHash: await hashPassword(PW), currency: 'INR',
  });
  await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
    [created.merchant.merchantId]);
  const tgId = await linkTelegram(created.userId);
  const first = await post('/api/merchant/auth/login', { mobile: m, password: PW });
  await answer(first.body.telegram, tgId);
  const session = await post('/api/merchant/auth/login/2fa', { challengeToken: first.body.challengeToken });
  const screen = await get('/api/merchant/telegram', session.body.token);
  check(A, 'merchant', 'sign in: password, no captcha, then Telegram', '200 a session; a merchant screen opens',
    `${first.status} twoFactorRequired=${first.body.twoFactorRequired}; ${session.status} amr=${JSON.stringify(amrOf(session.body.token))}; screen ${screen.status}`,
    first.body.twoFactorRequired === true && session.status === 200
      && same(amrOf(session.body.token), ['pwd', 'tg']) && screen.status === 200);

  // Forgot password: the panel's link opens the Mini App on `reset-MERCHANT`.
  const setup = await get('/api/telegram/mini-app?panel=MERCHANT');
  check(A, 'merchant', "the login page's Forgot password link", 'opens the Mini App on reset-MERCHANT',
    `${setup.status} ${setup.body.resetUrl}`, setup.status === 200 && String(setup.body.resetUrl).includes('startapp=reset-MERCHANT'));
  const initData = signInitData({ telegramUserId: tgId, startParam: 'reset-MERCHANT' });
  const contact = () => signContact({ telegramUserId: tgId, phone: `91${m}` });
  const weak = await post('/api/telegram/mini-app/password-reset', { initData, contact: contact(), password: 'Eleven-char', confirmPassword: 'Eleven-char' });
  check(A, 'merchant', 'a new password under the merchant floor (12)', '400 WEAK_PASSWORD, the page still usable',
    `${weak.status} ${weak.body.code}`, weak.status === 400 && weak.body.code === 'WEAK_PASSWORD');
  const reset = await post('/api/telegram/mini-app/password-reset', { initData, contact: contact(), password: NEW_PW, confirmPassword: NEW_PW });
  const old = await get('/api/merchant/telegram', session.body.token);
  check(A, 'merchant', 'the same page, a strong password', '200 changed; the open session is signed out',
    `${reset.status} changed=${reset.body.changed}; old session ${screen.status} then ${old.status} ${old.body.code ?? ''}`,
    reset.status === 200 && reset.body.changed === true && screen.status === 200 && old.status === 401);
  const replay = await post('/api/telegram/mini-app/password-reset', { initData, contact: contact(), password: `${NEW_PW}x`, confirmPassword: `${NEW_PW}x` });
  check(A, 'attacker', 'replay the spent Mini App proof', '409, the password unchanged', `${replay.status} ${replay.body.code}`,
    replay.status === 409);

  // The door paces one password try per mobile every 10 s; wait it out rather
  // than measure it (s8 measures the limiters).
  await sleep(10_500);
  const withNew = await post('/api/merchant/auth/login', { mobile: m, password: NEW_PW });
  check(A, 'merchant', 'sign in with the new password', '200 twoFactorRequired (Telegram still approves)',
    `${withNew.status} twoFactorRequired=${withNew.body.twoFactorRequired}`,
    withNew.status === 200 && withNew.body.twoFactorRequired === true);
}

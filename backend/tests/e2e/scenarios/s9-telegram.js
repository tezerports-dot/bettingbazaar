// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 9: Step 3, through the Mini App, against the real server ────────
//
// Every other scenario MINTS its sessions (harness.js says why). This one
// earns them, the way a person does: "Continue with Telegram" for players and
// merchants, signup and sign-in alike (owner, 2026-10-13/14) — the number
// match on a laptop, the handoff ticket on a phone, the contact shared once at
// the first Verify, a merchant application waiting for an admin — and a staff
// sign-in, which is a password and an authenticator code with no Telegram
// (owner, 2026-10-13).
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
// the server with TRUST_PROXY=1): the Telegram limiters key on the address, and
// this scenario is not here to measure them.
import { setTimeout as sleep } from 'node:timers/promises';
import { pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { hashPassword } from '../../../domains/identity/password.util.js';
import { base32Decode, totp } from '../../../domains/identity/totp.service.js';
import { tryVerifyPaseto } from '../../../domains/identity/paseto.util.js';
import { generateReferralCode } from '../../../domains/referral/referral.service.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId, TEST_BOT,
} from '../../miniAppFixture.js';
import { api, check, note, rid } from '../harness.js';

const A = 'TELEGRAM';
const PW = 'E2e-Step3-Pass-7q!';

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

/** The Mini App page answering the sign-in it was opened on: Verify (with the number picked) or Deny. */
const answer = (telegram, tgId, { decision = 'approve', phone = null, pick } = {}) => post('/api/telegram/mini-app/approve', {
  initData: signInitData({ telegramUserId: tgId, startParam: startParam(telegram) }),
  ...(phone ? { contact: signContact({ telegramUserId: tgId, phone: `91${phone}` }) } : {}),
  ...(typeof pick === 'number' ? { pick } : {}),
  decision,
});
/** The one-time ticket in the address Verify opens. */
const ticketOf = (redirectUrl) => String(redirectUrl || '').split('#/tg/')[1] || '';

const linkOf = async (userId) => (await pgQuery(
  'SELECT telegram_user_id, phone FROM telegram_links WHERE user_id = $1', [userId])).rows[0] ?? null;
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
    await playerContinueWithTelegram();
    await staffSignIn();
    await merchantContinueWithTelegram();
  } finally {
    if (!before[0]) await removeTestBot();
  }
}

// ── A player: Continue with Telegram, signup and sign-in alike ──────────────
async function playerContinueWithTelegram() {
  const referrer = rid('referrer');
  const code = generateReferralCode();
  await db.users.createUser({ userId: referrer, username: referrer, mobile: mobile(), referralCode: code });

  // ── A laptop: the number match, and the first Verify makes the account ──
  const m = mobile();
  const tgId = freshTelegramUserId();
  const open = await post('/api/v1/auth/login/telegram', { delivery: 'MATCH', referralCode: code });
  check(A, 'player', 'Continue with Telegram on a laptop, with an invite code', '200 pending, a number to show, no session',
    `${open.status} pending=${open.body.pending} match=${open.body.matchNumber} token=${Boolean(open.body.token)}`,
    open.status === 200 && open.body.pending === true && Number.isInteger(open.body.matchNumber)
      && Boolean(startParam(open.body.telegram)) && !open.body.token);

  const ctx = await post('/api/telegram/mini-app/context', {
    initData: signInitData({ telegramUserId: tgId, startParam: startParam(open.body.telegram) }),
  });
  const choices = ctx.body.start?.choices ?? [];
  check(A, 'mini app', 'the Verify screen', 'a new account, three numbers including the right one, the request named',
    `${ctx.status} ${ctx.body.start?.kind} isNew=${ctx.body.start?.account?.isNew} choices=${JSON.stringify(choices)} ip=${Boolean(ctx.body.start?.request?.ip)}`,
    ctx.status === 200 && ctx.body.start?.kind === 'TELEGRAM_LOGIN' && ctx.body.start?.account?.isNew === true
      && choices.length === 3 && choices.includes(open.body.matchNumber) && Boolean(ctx.body.start?.request?.at));

  const wrongPick = choices.find((n) => n !== open.body.matchNumber);
  const wrong = await answer(open.body.telegram, tgId, { phone: m, pick: wrongPick });
  check(A, 'mini app', 'Verify with the wrong number', '400 WRONG_NUMBER, no account made',
    `${wrong.status} ${wrong.body.code}; account=${Boolean(await db.users.getUserByMobile(m, 'PLAYER'))}`,
    wrong.status === 400 && wrong.body.code === 'WRONG_NUMBER' && !(await db.users.getUserByMobile(m, 'PLAYER')));

  const stranger = await answer(open.body.telegram, freshTelegramUserId(), { pick: open.body.matchNumber });
  check(A, 'mini app', 'a Telegram with no account and no contact', 'refused, nothing made',
    `${stranger.status} ${stranger.body.code}`, stranger.status >= 400 && !stranger.body.approved);

  const ok = await answer(open.body.telegram, tgId, { phone: m, pick: open.body.matchNumber });
  const joiner = await db.users.getUserByMobile(m, 'PLAYER');
  const link = joiner ? await linkOf(joiner.userId) : null;
  check(A, 'mini app', 'Verify with the right number, sharing the contact (+91 form)', '200 approved, created; linked to the ten-digit mobile',
    `${ok.status} approved=${ok.body.approved} created=${ok.body.created}; link phone=${link?.phone}`,
    ok.status === 200 && ok.body.approved === true && ok.body.created === true
      && link?.phone === m && link?.telegram_user_id === tgId);
  check(A, 'player', 'the invite is recorded and pays the referrer, in that transaction', `referred by ${referrer}; 1 earning`,
    `${joiner?.referredBy}; ${joiner ? await earningsFrom(joiner.userId) : '?'}`,
    joiner?.referredBy === referrer && (await earningsFrom(joiner.userId)) === 1);
  const pw = (await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [joiner.userId])).rows[0];
  check(A, 'player', 'the account has no password', 'NULL', `${pw?.password_hash ?? 'NULL'}`, pw && pw.password_hash === null);

  const session = await post('/api/v1/auth/login/telegram/complete', { challengeToken: open.body.challengeToken });
  check(A, 'player', 'the waiting laptop polls', '200 a session proved by Telegram',
    `${session.status} amr=${JSON.stringify(amrOf(session.body.token))}`,
    session.status === 200 && same(amrOf(session.body.token), ['tg']));
  const me = await get('/api/v1/auth/me', session.body.token);
  check(A, 'player', 'the session works', '200', `${me.status}`, me.status === 200);
  const again = await post('/api/v1/auth/login/telegram/complete', { challengeToken: open.body.challengeToken });
  check(A, 'attacker', 'redeem the same approval twice', 'refused', `${again.status} ${again.body.code}`,
    again.status >= 400 && !again.body.token);

  // ── A phone: the handoff ticket ────────────────────────────────────────
  // A HANDOFF is granted only to an app that opens at the site's own address
  // (deliveryFor): the one run.js gives the server.
  const site = process.env.PUBLIC_APP_ORIGIN || 'https://e2e.bettingbazaar.test';
  const phone = await post('/api/v1/auth/login/telegram', { delivery: 'HANDOFF', returnOrigin: site });
  const handed = await answer(phone.body.telegram, tgId);
  const t = ticketOf(handed.body.redirectUrl);
  check(A, 'mini app', 'Verify a phone sign-in', '200, opens the site with a one-time ticket in the fragment',
    `${handed.status} ${String(handed.body.redirectUrl).replace(t, '<ticket>')}`,
    handed.status === 200 && handed.body.approved === true && t.length >= 40);
  const poll = await post('/api/v1/auth/login/telegram/complete', { challengeToken: phone.body.challengeToken });
  check(A, 'attacker', 'the page that asked for a handoff polls', 'told it was handed off; no session',
    `${poll.status} handedOff=${poll.body.handedOff} token=${Boolean(poll.body.token)}`,
    poll.body.handedOff === true && !poll.body.token);
  const redeemed = await post('/api/v1/auth/login/telegram/ticket', { ticket: t });
  check(A, 'player', 'the site opened by Verify spends the ticket', '200 a session proved by Telegram',
    `${redeemed.status} amr=${JSON.stringify(amrOf(redeemed.body.token))}`,
    redeemed.status === 200 && same(amrOf(redeemed.body.token), ['tg']));
  const reused = await post('/api/v1/auth/login/telegram/ticket', { ticket: t });
  check(A, 'attacker', 'spend the ticket again', '401 TICKET_INVALID', `${reused.status} ${reused.body.code}`,
    reused.status === 401 && reused.body.code === 'TICKET_INVALID');
  const elsewhere = await post('/api/merchant/auth/login/telegram/ticket', { ticket: t });
  check(A, 'attacker', "a player's ticket at the merchant door", 'refused', `${elsewhere.status}`, elsewhere.status >= 400 && !elsewhere.body.token);

  // ── Deny ───────────────────────────────────────────────────────────────
  const denyMe = await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' });
  const denied = await answer(denyMe.body.telegram, tgId, { decision: 'deny' });
  const after = await post('/api/v1/auth/login/telegram/complete', { challengeToken: denyMe.body.challengeToken });
  check(A, 'player', 'Deny in Telegram', 'refused; the page is told so', `${denied.status} ${denied.body.approved}; ${after.status} ${after.body.code}`,
    denied.status === 200 && denied.body.approved === false && after.status === 401 && after.body.code === 'TWO_FACTOR_DENIED');

  // ── Opened from a referral link inside Telegram ────────────────────────
  const m2 = mobile();
  const tg2 = freshTelegramUserId();
  const cont = await post('/api/telegram/mini-app/continue', {
    initData: signInitData({ telegramUserId: tg2, startParam: `ref-${code}` }),
    contact: signContact({ telegramUserId: tg2, phone: `91${m2}` }),
  });
  const viaLink = await post('/api/v1/auth/login/telegram/ticket', { ticket: ticketOf(cont.body.redirectUrl) });
  const second = await db.users.getUserByMobile(m2, 'PLAYER');
  check(A, 'player', 'a referral link opened in Telegram: Verify makes the account and opens the site signed in', '200 created; a session; referred',
    `${cont.status} created=${cont.body.created}; ${viaLink.status}; referredBy=${second?.referredBy}`,
    cont.status === 200 && cont.body.created === true && viaLink.status === 200 && second?.referredBy === referrer);

  // ── Nothing reads a password ───────────────────────────────────────────
  const form = await post('/api/v1/auth/login', { mobile: m, password: PW });
  check(A, 'attacker', 'the removed password door', '404 or 401', `${form.status}`, form.status === 404 || form.status === 401);
}

// ── Staff: the password, then an authenticator code; never Telegram ─────────
// (owner, 2026-10-13). The first sign-in enrols the app; later ones type a code.
async function staffSignIn() {
  const userId = rid('staff');
  const m = mobile().replace(/^9/, '8');
  await db.users.createUser({ userId, username: userId, mobile: m, passwordHash: await hashPassword(PW), accountType: 'STAFF', isAdmin: true });
  await db.users.setRoles(userId, ['admin']);

  const first = await post('/api/admin/login', { mobile: m, password: PW });
  check(A, 'staff', 'sign in with the password, no captcha, no authenticator yet', '200 totpSetupRequired, no Telegram step, no session',
    `${first.status} totpSetupRequired=${first.body.totpSetupRequired} telegram=${Boolean(first.body.telegram)} token=${Boolean(first.body.token)}`,
    first.status === 200 && first.body.totpSetupRequired === true && !first.body.telegram && !first.body.token);
  const tg = await post('/api/admin/login/2fa', { challengeToken: first.body.challengeToken });
  check(A, 'staff', 'the old Telegram leg', 'no sign-in leg there: no session, no Telegram step',
    `${tg.status} token=${Boolean(tg.body?.token)} telegram=${Boolean(tg.body?.telegram)}`,
    tg.status >= 400 && !tg.body?.token && !tg.body?.telegram);

  const setup = await post('/api/admin/login/totp/setup', { challengeToken: first.body.challengeToken });
  const secret = base32Decode(setup.body.secret || '');
  const firstCode = totp(secret);
  const session = await post('/api/admin/login/totp/activate', {
    challengeToken: first.body.challengeToken, code: firstCode,
  });
  check(A, 'staff', 'scan the QR, type the first code', '200 a session proved by password and authenticator, ten recovery codes',
    `${setup.status} qr=${String(setup.body.qrDataUrl || '').slice(0, 15)}; ${session.status} amr=${JSON.stringify(amrOf(session.body.token))} codes=${session.body.recoveryCodes?.length}`,
    setup.status === 200 && String(setup.body.qrDataUrl).startsWith('data:image/png')
      && session.status === 200 && same(amrOf(session.body.token), ['pwd', 'otp']) && session.body.recoveryCodes?.length === 10);
  const mine = await get('/api/admin/account/2fa', session.body.token);
  check(A, 'staff', 'the session opens a staff screen', '200 enrolled', `${mine.status} ${mine.body.enrolled}`,
    mine.status === 200 && mine.body.enrolled === true);

  // The staff door paces one password try per mobile every 10 s (the first
  // sign-in above was one); wait it out rather than measure it (s8 measures it).
  await sleep(10_500);
  const second = await post('/api/admin/login', { mobile: m, password: PW });
  const replay = await post('/api/admin/login/totp', { challengeToken: second.body.challengeToken, code: firstCode });
  check(A, 'attacker', 'replay the code that was just used', '401 TOTP_INVALID, no session',
    `${second.status} ${second.body.code ?? ''} totpRequired=${second.body.totpRequired}; ${replay.status} ${replay.body.code}`,
    second.body.totpRequired === true && replay.status === 401 && replay.body.code === 'TOTP_INVALID' && !replay.body.token);
  const recovery = await post('/api/admin/login/totp', {
    challengeToken: second.body.challengeToken, code: session.body.recoveryCodes[0],
  });
  check(A, 'staff', 'sign in with a recovery code', '200, nine left', `${recovery.status} ${recovery.body.recoveryCodesLeft}`,
    recovery.status === 200 && recovery.body.recoveryCodesLeft === 9);
}

// ── A merchant: an application by Telegram, and the approved merchant's sign-in ──
async function merchantContinueWithTelegram() {
  const am = mobile().replace(/^9/, '7');
  const atg = freshTelegramUserId();
  const apply = await post('/api/merchant/auth/login/telegram', { delivery: 'MATCH' });
  const verified = await answer(apply.body.telegram, atg, { phone: am, pick: apply.body.matchNumber });
  const applicant = await db.users.getUserByMobile(am, 'MERCHANT');
  const row = applicant ? (await pgQuery('SELECT status FROM merchants WHERE user_id = $1', [applicant.userId])).rows[0] : null;
  check(A, 'merchant', 'a first Verify submits an application', '200 created, no site to open; a PENDING merchant',
    `${verified.status} created=${verified.body.created} redirect=${verified.body.redirectUrl}; ${row?.status}`,
    verified.status === 200 && verified.body.created === true && !verified.body.redirectUrl && row?.status === 'PENDING');
  const waiting = await post('/api/merchant/auth/login/telegram/complete', { challengeToken: apply.body.challengeToken });
  check(A, 'merchant', 'the page polls before an admin approves', '403 MERCHANT_NOT_ACTIVE (worded), no session',
    `${waiting.status} ${waiting.body.code}`, waiting.status === 403 && waiting.body.code === 'MERCHANT_NOT_ACTIVE' && !waiting.body.token);

  // An approved merchant signs in: the Telegram sign-in is the second factor.
  const m = mobile().replace(/^9/, '7');
  const created = await createMerchantAccount({
    userId: db.users.newUserId(), username: rid('m').replace(/-/g, ''), mobile: m, currency: 'INR',
  });
  await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
    [created.merchant.merchantId]);
  const tgId = await linkTelegram(created.userId);
  const first = await post('/api/merchant/auth/login/telegram', { delivery: 'MATCH' });
  await answer(first.body.telegram, tgId, { pick: first.body.matchNumber });
  const session = await post('/api/merchant/auth/login/telegram/complete', { challengeToken: first.body.challengeToken });
  const screen = await get('/api/merchant/profile', session.body.token);
  check(A, 'merchant', 'Continue with Telegram, no captcha, no password', '200 a session proved by Telegram; a merchant screen opens',
    `${first.status}; ${session.status} amr=${JSON.stringify(amrOf(session.body.token))}; screen ${screen.status}`,
    first.status === 200 && session.status === 200 && same(amrOf(session.body.token), ['tg']) && screen.status === 200);
  const pw = await post('/api/merchant/auth/login', { mobile: m, password: PW });
  check(A, 'attacker', 'the removed merchant password door', '404 or 401', `${pw.status}`, pw.status === 404 || pw.status === 401);
}

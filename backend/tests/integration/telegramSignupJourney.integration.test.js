// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The whole signup, driven the way Telegram drives it.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 * Every piece of the Telegram path has unit tests, and every one of them passes
 * against a path that does not actually work end to end. The unit tests prove
 * that `completeContactShare` creates a user, that `issueLoginToken` mints a
 * redeemable token, that the channel gate refuses a non-member. None of them
 * proves that a real person, tapping a real referral link, ends up with an
 * account, a session, an upline that earned, and the ability to place a bet.
 *
 * This is the launch path. It is the sequence that has never been run, because
 * the platform has never been hosted — so it is exactly the sequence that will
 * fail on the day if anything in it is wrong.
 *
 * ── What is real here and what is not ───────────────────────────────────────
 * Real: MongoDB with transactions, every model and its indexes, the actual
 * Express routers, the real session issuer, the real channel gate, the real
 * referral ledger.
 *
 * Stubbed: the Telegram Bot API itself, since there is no bot to talk to. Sends
 * are captured so the test can assert WHAT the player was told and, just as
 * importantly, when they were told nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';

// ── The Bot API, captured rather than called ────────────────────────────────
const sent = [];
const api = {
  // Set by each test to control what Telegram "says".
  chatMemberStatus: 'left',
};

vi.mock('../../domains/telegram/telegramClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callApi: async (token, method, payload) => {
      sent.push({ method, chatId: payload?.chat_id, text: payload?.text, payload });
      if (method === 'getChatMember') return { ok: true, result: { status: api.chatMemberStatus } };
      return { ok: true, result: {} };
    },
    sendMessage: async (chatId, text, extra) => {
      sent.push({ method: 'sendMessage', chatId, text, payload: extra });
      return { ok: true, result: {} };
    },
    fetchChatMemberStatus: async () => ({ ok: true, status: api.chatMemberStatus, generation: 1 }),
  };
});

const { TelegramConfig, TelegramIdentity, TelegramPendingLink, TelegramLoginToken } =
  await import('../../domains/telegram/telegram.model.js');
const { invalidateConfigCache } = await import('../../domains/telegram/telegramClient.js');
const { default: telegramRoutes } = await import('../../domains/telegram/telegram.routes.js');
const { default: referralRedirect } = await import('../../routes/referralRedirect.routes.js');
const { User } = await import('../../models/index.js');
const { ReferralEarning } = await import('../../domains/referral/referral.model.js');
const { KycVerification } = await import('../../domains/identity/kycVerification.model.js');
const { generateReferralCode, nextJoiningNumber } =
  await import('../../domains/referral/referral.service.js');
const { encryptField } = await import('../../domains/identity/fieldCrypto.util.js');

const WEBHOOK_SECRET = 'test-webhook-secret-value';
const CHANNEL_ID = '-1001234567890';

/**
 * A REAL ciphertext, not a placeholder.
 *
 * `activeConfig` decrypts this to get the bot token, and `sendTemplate` refuses
 * to send at all without one — so a config carrying a null token would make
 * every assertion about what the bot said fail for a reason that has nothing to
 * do with what is being tested.
 */
const BOT_TOKEN_CIPHERTEXT = encryptField('123456789:AA-test-bot-token');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/telegram', telegramRoutes);
  a.use('/', referralRedirect);
  return a;
}

/** Post an update exactly as Telegram would, secret header and all. */
function update(body, secret = WEBHOOK_SECRET) {
  return request(app())
    .post('/api/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', secret)
    .send(body);
}

/**
 * The webhook answers 200 BEFORE doing its work, so the assertion that follows
 * a post would otherwise race the handler. This waits for the effect rather
 * than for a fixed delay, which is what makes the suite stable rather than
 * merely usually-green.
 */
async function until(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Wait long enough for a handler to have finished, then assert it did nothing.
 *
 * A POSITIVE assertion can poll for the effect it wants (`until` above). A
 * NEGATIVE one — "no message was sent" — has no effect to wait for, and
 * asserting immediately would pass simply because the handler had not reached
 * the send yet. That is the classic shape of a test which is green until the
 * machine is busy.
 *
 * So negative assertions get a bounded settle. It is deliberately far longer
 * than the work involved, because the cost of waiting is a few milliseconds and
 * the cost of not waiting is a test that lies.
 */
const settle = () => new Promise((r) => setTimeout(r, 400));

/**
 * The next message sent to a chat AFTER a marker.
 *
 * Not "the last message sent to this chat" — that was a real bug in this
 * harness, and a instructive one. `until` resolves on the first truthy value,
 * and a conversation has usually already produced a message by the time the
 * step under test runs. So the poll returned the PREVIOUS reply instantly and
 * the assertion compared against it: a test for "we refuse a duplicate Aadhaar"
 * was reading the welcome message and failing with a confusing diff, while a
 * genuinely broken refusal would have looked identical.
 *
 * The mark must be taken immediately before the action, so the wait is for
 * something NEW rather than for something. Prefer `say` below, which takes it
 * for you — see there for why taking it by hand is easy to get wrong.
 */
const sentAfter = (mark, chatId) =>
  sent.slice(mark).find((s) => String(s.chatId) === String(chatId) && s.method === 'sendMessage');

/**
 * Post an update and wait for the reply it produces, in one step.
 *
 * ── Why the mark cannot be taken by hand ────────────────────────────────────
 * `sentAfter` fixed HALF of this harness's ordering problem: the assertion no
 * longer reads a message that predates the action. It cannot fix the other
 * half, because that one happens before it is ever called.
 *
 * The webhook answers 200 before doing its work, so a step used to be sequenced
 * by waiting on the DATABASE row the handler writes:
 *
 *     await update({ …'/start' });
 *     await until(() => TelegramPendingLink.findOne(…));   // row exists
 *     const mark = sent.length;                            // ← too early
 *
 * The handler writes that row and THEN sends the welcome. So the row can exist
 * while the welcome is still in flight, the mark is taken at a length the
 * welcome has not reached yet, and the next `sentAfter(mark, …)` returns the
 * welcome — the exact message the mark was meant to exclude. A DB row and the
 * send log are two different clocks, and the mark belongs to the send log.
 *
 * That failure is timing-dependent, which is the worst property it could have:
 * it passed locally and on one CI run, then failed on the next with a diff
 * ("expected the welcome to match /already registered/") that points at the
 * assertion rather than at the race.
 *
 * So: take the mark, post, and wait for the reply, with no window in between
 * for a caller to sequence on the wrong thing. Waiting for THIS reply is also
 * what makes the NEXT step's mark safe.
 *
 * Only for steps that do reply — a negative assertion has nothing to wait for
 * and must use `settle()`.
 */
async function say(body, chatId) {
  const mark = sent.length;
  await update(body);
  return until(() => sentAfter(mark, chatId));
}

beforeEach(async () => {
  sent.length = 0;
  api.chatMemberStatus = 'left';
  invalidateConfigCache();

  await TelegramConfig.create({
    generation: 1,
    botTokenEncrypted: BOT_TOKEN_CIPHERTEXT,
    botUsername: 'bazaar_signin_bot',
    webhookSecret: WEBHOOK_SECRET,
    channelId: CHANNEL_ID,
    channelUsername: 'bettingbazaar',
    channelInviteLink: 'https://t.me/+invite',
    active: true,
  });
  invalidateConfigCache();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a referred player signs up, start to finish', () => {
  it('walks the link, the Aadhaar, the contact and the join into an account', async () => {
    // ── A referrer already exists, with a code and a queue position ─────────
    const referrerCode = generateReferralCode();
    const referrer = await User.create({
      username: 'Referrer', mobile: '9800000001',
      referralCode: referrerCode, joiningNumber: await nextJoiningNumber(),
    });

    // ── 1. The invited player taps the shared link ─────────────────────────
    // It points at OUR domain, not at t.me, so it survives a bot replacement.
    const redirect = await request(app()).get(`/r/${referrerCode}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(
      `https://t.me/bazaar_signin_bot?start=${referrerCode}`);

    // The click is counted against the referrer, deduplicated per viewer.
    await until(async () =>
      (await User.findById(referrer._id).select('referralClicks').lean())?.referralClicks === 1);

    // ── 2. Telegram opens the bot and sends /start with the payload ────────
    // This is what the START button produces: the code arrives as the argument,
    // so the invited player never types anything.
    await update({
      message: {
        message_id: 1, chat: { id: 55501 },
        from: { id: 55501, first_name: 'Invited', username: 'invited' },
        text: `/start ${referrerCode}`,
      },
    });

    const pending = await until(() => TelegramPendingLink.findOne({ telegramUserId: '55501' }).lean());
    expect(pending.step).toBe('AWAITING_AADHAAR');
    // Attribution is captured HERE and nowhere else — this message is the only
    // one that ever carries it.
    expect(pending.referralCode).toBe(referrerCode);

    // ── 3. They send their Aadhaar ────────────────────────────────────────
    await update({
      message: {
        message_id: 2, chat: { id: 55501 },
        from: { id: 55501, first_name: 'Invited' },
        text: '123456789012',
      },
    });

    await until(async () =>
      (await TelegramPendingLink.findOne({ telegramUserId: '55501' }).lean())?.step === 'AWAITING_CONTACT');

    // The plaintext is never stored: a hash for the duplicate check, ciphertext
    // for the eventual verification export, and the last four for a human.
    const held = await TelegramPendingLink.findOne({ telegramUserId: '55501' })
      .select('+aadhaarEncrypted').lean();
    expect(held.aadhaarHash).toBeTruthy();
    expect(held.aadhaarLast4).toBe('9012');
    expect(JSON.stringify(held)).not.toContain('123456789012');

    // ── 4. They tap "share my contact" — the account comes into being ─────
    await update({
      message: {
        message_id: 3, chat: { id: 55501 },
        from: { id: 55501, first_name: 'Invited' },
        contact: { phone_number: '+919800000042', user_id: 55501 },
      },
    });

    const player = await until(() => User.findOne({ mobile: '9800000042' }).lean());
    expect(player.referredBy?.toString()).toBe(referrer._id.toString());
    expect(player.kycStatus).toBe('PENDING_APPROVAL');
    // NOT yet numbered: a joining number consumed by somebody who never joins
    // the channel would leave a permanent gap ahead of people who did.
    expect(player.joiningNumber).toBeFalsy();

    const kyc = await KycVerification.findOne({ userId: player._id }).lean();
    expect(kyc.status).toBe('PENDING_VERIFICATION');

    // ── 5. They join the channel ──────────────────────────────────────────
    api.chatMemberStatus = 'member';
    const mark = sent.length;   // only messages sent AFTER the join count
    await update({
      chat_member: {
        chat: { id: CHANNEL_ID },
        from: { id: 55501 },
        new_chat_member: { user: { id: 55501 }, status: 'member' },
      },
    });

    const numbered = await until(async () => {
      const u = await User.findById(player._id).lean();
      return u.joiningNumber ? u : null;
    });
    expect(numbered.joiningNumber).toBeGreaterThan(0);

    // ── 6. The upline earned, at both levels that exist ───────────────────
    const earned = await ReferralEarning.find({ sourceUserId: player._id }).lean();
    expect(earned).toHaveLength(1);                 // referrer has no referrer
    expect(earned[0].earnerId.toString()).toBe(referrer._id.toString());
    expect(earned[0].level).toBe(1);
    expect(earned[0].amountPaise).toBe(2500);       // ₹25

    // ── 7. The bot sent a login link, and it works exactly once ───────────
    const link = await until(() => sentAfter(mark, 55501));
    const token = /token=([A-Za-z0-9_-]+)/.exec(link.text)?.[1];
    expect(token, 'the login message must carry a token').toBeTruthy();

    const exchanged = await request(app()).post('/api/telegram/exchange').send({ token });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.success).toBe(true);

    const replay = await request(app()).post('/api/telegram/exchange').send({ token });
    expect(replay.status, 'a forwarded link must not mint a second session').toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the webhook is not an open door', () => {
  it('refuses an update with the wrong secret, and does nothing', async () => {
    await update({
      message: {
        message_id: 1, chat: { id: 55502 },
        from: { id: 55502, first_name: 'Forged' }, text: '/start',
      },
    }, 'not-the-secret').expect(401);

    await settle();
    expect(await TelegramPendingLink.findOne({ telegramUserId: '55502' })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('refuses an update with no secret at all', async () => {
    await request(app()).post('/api/telegram/webhook')
      .send({ message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: '/start' } })
      .expect(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('one Aadhaar, one account', () => {
  it('refuses a second signup on an Aadhaar that is already registered', async () => {
    const first = await User.create({ username: 'First', mobile: '9800000010' });
    const { hashAadhaar } = await import('../../domains/identity/aadhaarHash.util.js');
    await KycVerification.create({
      userId: first._id,
      aadhaarHash: hashAadhaar('999988887777'),
      // Required on the schema, and rightly so — a KYC row with no recoverable
      // Aadhaar could never be exported for verification.
      aadhaarEncrypted: encryptField('999988887777'),
      aadhaarLast4: '7777', phone: '9800000010', status: 'PENDING_VERIFICATION',
    });

    await say({ message: { message_id: 1, chat: { id: 55503 }, from: { id: 55503 }, text: '/start' } }, 55503);

    const told = await say({
      message: { message_id: 2, chat: { id: 55503 }, from: { id: 55503 }, text: '999988887777' },
    }, 55503);
    expect(told.text).toMatch(/already registered/i);

    // Still at the Aadhaar step — no account, no progress.
    const stuck = await TelegramPendingLink.findOne({ telegramUserId: '55503' }).lean();
    expect(stuck.step).toBe('AWAITING_AADHAAR');
    expect(stuck.aadhaarHash).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a forwarded contact card cannot register somebody else', () => {
  it('refuses a contact whose user_id is not the sender', async () => {
    await say({ message: { message_id: 1, chat: { id: 55504 }, from: { id: 55504 }, text: '/start' } }, 55504);
    await say({ message: { message_id: 2, chat: { id: 55504 }, from: { id: 55504 }, text: '111122223333' } }, 55504);
    // The prompt has been sent, so the step has advanced — but assert it, since
    // this test is meaningless if the contact card arrives at the wrong step.
    expect((await TelegramPendingLink.findOne({ telegramUserId: '55504' }).lean()).step)
      .toBe('AWAITING_CONTACT');

    // Somebody ELSE's contact card, forwarded into the chat.
    const told = await say({
      message: {
        message_id: 3, chat: { id: 55504 }, from: { id: 55504 },
        contact: { phone_number: '+919800000099', user_id: 999999 },
      },
    }, 55504);
    expect(told.text).toMatch(/YOUR OWN contact/i);
    expect(await User.findOne({ mobile: '9800000099' })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a channel replacement does not spam the whole user base', () => {
  /**
   * THE BUG THIS PINS
   *
   * `chat_member` fires on every join, and replacing the channel makes every
   * existing player join. Treating each of those as a finished signup would
   * mint a login token and push a message to the ENTIRE active user base — at
   * the exact moment they are all trying to sign in through the one bot, and
   * against a Bot API limit of roughly thirty messages a second. The flip would
   * rate-limit the recovery it exists to enable, and the messages would be
   * unsolicited login links to people already signed in.
   */
  it('sends nothing to a player who has signed up before and is merely re-joining', async () => {
    const veteran = await User.create({
      username: 'Veteran', mobile: '9800000055',
      joiningNumber: await nextJoiningNumber(), referralCode: generateReferralCode(),
    });
    await TelegramIdentity.create({
      telegramUserId: '55505', userId: veteran._id,
      phone: '9800000055', contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });

    api.chatMemberStatus = 'member';
    await update({
      chat_member: {
        chat: { id: CHANNEL_ID }, from: { id: 55505 },
        new_chat_member: { user: { id: 55505 }, status: 'member' },
      },
    });

    // The membership cache IS updated — that is the point of the event.
    await until(async () =>
      (await TelegramIdentity.findOne({ telegramUserId: '55505' }).lean())?.channelStatus === 'member');

    // …and nothing was sent, and no token was minted. Settled first: the cache
    // write happens BEFORE the branch under test, so asserting on the poll
    // alone would be checking a handler that had not got there yet.
    await settle();
    expect(sent.filter((s) => String(s.chatId) === '55505')).toHaveLength(0);
    expect(await TelegramLoginToken.countDocuments({ userId: veteran._id })).toBe(0);
  });

  it('still sends the link to somebody finishing a signup for the first time', async () => {
    // The other side of the same branch: without this, "send nothing" would be
    // a passing test for a completely broken signup.
    const fresh = await User.create({ username: 'Fresh', mobile: '9800000056' });
    await TelegramIdentity.create({
      telegramUserId: '55506', userId: fresh._id,
      phone: '9800000056', contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });

    api.chatMemberStatus = 'member';
    const mark = sent.length;
    await update({
      chat_member: {
        chat: { id: CHANNEL_ID }, from: { id: 55506 },
        new_chat_member: { user: { id: 55506 }, status: 'member' },
      },
    });

    const link = await until(() => sentAfter(mark, 55506));
    expect(link.text).toMatch(/token=/);
    expect((await User.findById(fresh._id).lean()).joiningNumber).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('attribution survives a code in the wrong case', () => {
  it('credits the referrer when the deep link arrives lower-cased', async () => {
    // Codes are generated upper case and looked up by exact match, so a
    // lower-cased payload used to match nothing — and the failure was silent:
    // the signup succeeded and the referrer simply never earned.
    const code = generateReferralCode();
    const referrer = await User.create({
      username: 'Ref2', mobile: '9800000021', referralCode: code, joiningNumber: await nextJoiningNumber(),
    });

    await update({
      message: {
        message_id: 1, chat: { id: 55507 }, from: { id: 55507, first_name: 'Lower' },
        text: `/start ${code.toLowerCase()}`,
      },
    });

    const pending = await until(() => TelegramPendingLink.findOne({ telegramUserId: '55507' }).lean());
    expect(pending.referralCode, 'the stored code must be normalised').toBe(code);

    await update({ message: { message_id: 2, chat: { id: 55507 }, from: { id: 55507 }, text: '444455556666' } });
    await until(async () =>
      (await TelegramPendingLink.findOne({ telegramUserId: '55507' }).lean())?.step === 'AWAITING_CONTACT');

    await update({
      message: {
        message_id: 3, chat: { id: 55507 }, from: { id: 55507 },
        contact: { phone_number: '+919800000077', user_id: 55507 },
      },
    });

    const player = await until(() => User.findOne({ mobile: '9800000077' }).lean());
    expect(player.referredBy?.toString(), 'the referrer must still be credited')
      .toBe(referrer._id.toString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('an existing player asking to log in', () => {
  it('gets a fresh link from /start rather than a second account', async () => {
    const existing = await User.create({ username: 'Returning', mobile: '9800000088', joiningNumber: await nextJoiningNumber() });
    await TelegramIdentity.create({
      telegramUserId: '55508', userId: existing._id,
      phone: '9800000088', contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });

    const mark = sent.length;
    await update({ message: { message_id: 1, chat: { id: 55508 }, from: { id: 55508 }, text: '/start' } });

    const link = await until(() => sentAfter(mark, 55508));
    expect(link.text).toMatch(/token=/);
    expect(await User.countDocuments({ mobile: '9800000088' })).toBe(1);
    expect(await TelegramPendingLink.countDocuments({ telegramUserId: '55508' })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the membership endpoint the join prompt polls', () => {
  it('reports a joined player from cache without calling Telegram', async () => {
    const { signToken } = await import('../../domains/identity/jwt.util.js');
    const u = await User.create({ username: 'Member', mobile: '9800000033' });
    await TelegramIdentity.create({
      telegramUserId: '55509', userId: u._id,
      phone: '9800000033', contactSharedAt: new Date(), contactActive: true,
      channelStatus: 'member', channelCheckedAt: new Date(), channelGeneration: 1,
    });

    sent.length = 0;
    const res = await request(app()).get('/api/telegram/membership')
      .set('Authorization', `Bearer ${signToken({ userId: u._id, mobile: u.mobile, role: 'user' })}`);

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    // The whole point: a flip prompts every player at once, and this path must
    // not turn that into one Bot API call per tap.
    expect(sent.filter((s) => s.method === 'getChatMember')).toHaveLength(0);
  });

  it('reports a player who has not joined, with the link to the current channel', async () => {
    const { signToken } = await import('../../domains/identity/jwt.util.js');
    const u = await User.create({ username: 'Outsider', mobile: '9800000034' });
    await TelegramIdentity.create({
      telegramUserId: '55510', userId: u._id,
      phone: '9800000034', contactSharedAt: new Date(), contactActive: true,
      channelStatus: 'left', channelCheckedAt: new Date(), channelGeneration: 1,
    });

    const res = await request(app()).get('/api/telegram/membership')
      .set('Authorization', `Bearer ${signToken({ userId: u._id, mobile: u.mobile, role: 'user' })}`);

    expect(res.body.joined).toBe(false);
    expect(res.body.telegram.inviteLink).toBe('https://t.me/+invite');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('replacing the channel', () => {
  it('makes every cached membership stale without touching any account', async () => {
    const { signToken } = await import('../../domains/identity/jwt.util.js');
    const u = await User.create({
      username: 'Established', mobile: '9800000044',
      joiningNumber: await nextJoiningNumber(), depositBalance: 500, winningsBalance: 250,
      referralCode: generateReferralCode(),
    });
    await TelegramIdentity.create({
      telegramUserId: '55511', userId: u._id,
      phone: '9800000044', contactSharedAt: new Date(), contactActive: true,
      channelStatus: 'member', channelCheckedAt: new Date(), channelGeneration: 1,
    });

    // The operator replaces the channel: generation 2 goes live.
    await TelegramConfig.updateMany({ active: true }, { $set: { active: false } });
    await TelegramConfig.create({
      generation: 2,
      botUsername: 'bazaar_signin_bot', webhookSecret: WEBHOOK_SECRET,
      channelId: '-1009999999999', channelUsername: 'bazaar_new',
      channelInviteLink: 'https://t.me/+newinvite', active: true,
    });
    invalidateConfigCache();

    // Telegram says they are not in the NEW channel.
    api.chatMemberStatus = 'left';

    const res = await request(app()).get('/api/telegram/membership')
      .set('Authorization', `Bearer ${signToken({ userId: u._id, mobile: u.mobile, role: 'user' })}`);

    expect(res.body.joined, 'a generation mismatch reads as "must join the new channel"').toBe(false);
    // …and it points at the NEW channel, which is the whole reason the prompt
    // carries a link rather than the app hard-coding one.
    expect(res.body.telegram.inviteLink).toBe('https://t.me/+newinvite');

    // Nothing about the person moved. Compared against the number this user was
    // actually allocated rather than a literal — joining numbers come from a
    // shared counter, so hard-coding one couples this assertion to how many
    // other fixtures happened to run first.
    const after = await User.findById(u._id).lean();
    expect(after.joiningNumber).toBe(u.joiningNumber);
    expect(after.depositBalance).toBe(500);
    expect(after.winningsBalance).toBe(250);
    expect(await TelegramIdentity.countDocuments({ userId: u._id })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a failed Aadhaar is released, and the player can try again', () => {
  /**
   * THE TWO THINGS THIS PINS
   *
   * 1. A failed submission's row is DELETED. `aadhaarHash` is unique, so a
   *    player who mistyped one digit has parked a stranger's Aadhaar in that
   *    index — and the stranger is then refused at signup with "already
   *    registered" for a number they never gave us. The typo locks out its real
   *    owner, silently, forever.
   * 2. The player is not stuck. Before this, their signup conversation was over,
   *    so sending a new number did nothing and support had no code path either.
   */
  async function rejectedPlayer(telegramId, mobile, aadhaar) {
    const { hashAadhaar } = await import('../../domains/identity/aadhaarHash.util.js');
    const u = await User.create({
      username: 'Mistyped', mobile,
      kycStatus: 'REJECTED', kycData: { submissionCount: 1, rejectionReason: 'Verification failed' },
    });
    await TelegramIdentity.create({
      telegramUserId: String(telegramId), userId: u._id,
      phone: mobile, contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });
    // The wrong number's row is already gone — that is what the release does.
    void hashAadhaar(aadhaar);
    return u;
  }

  it('takes a corrected number from /start and re-queues it', async () => {
    const u = await rejectedPlayer(55601, '9800000201', '111111111111');

    const prompt = await say(
      { message: { message_id: 1, chat: { id: 55601 }, from: { id: 55601 }, text: '/start' } }, 55601);
    // NOT a login link: a session would drop them into an app that refuses
    // every action and offers nothing to do about it.
    expect(prompt.text).toMatch(/could not be verified/i);
    expect(prompt.text).not.toMatch(/token=/);

    const accepted = await say(
      { message: { message_id: 2, chat: { id: 55601 }, from: { id: 55601 }, text: '222222222222' } }, 55601);
    expect(accepted.text).toMatch(/2222/);

    const kyc = await until(() => KycVerification.findOne({ userId: u._id }).lean());
    expect(kyc.status).toBe('PENDING_VERIFICATION');
    expect(kyc.aadhaarLast4).toBe('2222');

    const after = await User.findById(u._id).lean();
    expect(after.kycStatus, 'back in the queue, through the state machine').toBe('PENDING_APPROVAL');
    expect(after.kycData.submissionCount).toBe(2);
  });

  it('frees the mistyped Aadhaar for whoever actually owns it', async () => {
    // The stranger signs up with the number the typo had been holding.
    await rejectedPlayer(55602, '9800000202', '333333333333');

    await say({ message: { message_id: 1, chat: { id: 55603 }, from: { id: 55603, first_name: 'RealOwner' }, text: '/start' } }, 55603);

    const reply = await say(
      { message: { message_id: 2, chat: { id: 55603 }, from: { id: 55603 }, text: '333333333333' } }, 55603);

    expect(reply.text, 'the real owner must not be refused').not.toMatch(/already registered/i);
    const pending = await TelegramPendingLink.findOne({ telegramUserId: '55603' }).lean();
    expect(pending.step).toBe('AWAITING_CONTACT');
  });

  it('refuses an Aadhaar that genuinely belongs to another account', async () => {
    const { hashAadhaar } = await import('../../domains/identity/aadhaarHash.util.js');
    const other = await User.create({ username: 'Other', mobile: '9800000204' });
    await KycVerification.create({
      userId: other._id,
      aadhaarHash: hashAadhaar('444444444444'),
      aadhaarEncrypted: encryptField('444444444444'),
      aadhaarLast4: '4444', phone: '9800000204', status: 'VERIFIED',
    });

    const u = await rejectedPlayer(55604, '9800000205', '555555555555');

    const mark = sent.length;
    await update({ message: { message_id: 1, chat: { id: 55604 }, from: { id: 55604 }, text: '444444444444' } });
    const reply = await until(() => sentAfter(mark, 55604));
    expect(reply.text).toMatch(/already registered/i);

    // Unchanged — a refused reapply must not consume the attempt or move status.
    const after = await User.findById(u._id).lean();
    expect(after.kycStatus).toBe('REJECTED');
    expect(after.kycData.submissionCount).toBe(1);
  });

  it('stops after the attempt cap, so it cannot become an enumeration oracle', async () => {
    const u = await User.create({
      username: 'Exhausted', mobile: '9800000206',
      kycStatus: 'REJECTED', kycData: { submissionCount: 3 },
    });
    await TelegramIdentity.create({
      telegramUserId: '55605', userId: u._id,
      phone: '9800000206', contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });

    const mark = sent.length;
    await update({ message: { message_id: 1, chat: { id: 55605 }, from: { id: 55605 }, text: '666666666666' } });
    const reply = await until(() => sentAfter(mark, 55605));
    expect(reply.text).toMatch(/contact support/i);
    // Crucially: it does NOT say whether that number is registered.
    expect(reply.text).not.toMatch(/already registered/i);
    expect(await KycVerification.countDocuments({ userId: u._id })).toBe(0);
  });

  it('refuses to replace an APPROVED Aadhaar', async () => {
    // The whole immutability rule. Without this branch, "reapply" would be a
    // way to change a verified identity.
    const { hashAadhaar } = await import('../../domains/identity/aadhaarHash.util.js');
    const u = await User.create({
      username: 'Verified', mobile: '9800000207',
      kycStatus: 'APPROVED', kycData: { submissionCount: 1 },
    });
    await KycVerification.create({
      userId: u._id,
      aadhaarHash: hashAadhaar('777777777777'),
      aadhaarEncrypted: encryptField('777777777777'),
      aadhaarLast4: '7777', phone: '9800000207', status: 'VERIFIED',
    });
    await TelegramIdentity.create({
      telegramUserId: '55606', userId: u._id,
      phone: '9800000207', contactSharedAt: new Date(), contactActive: true,
      channelGeneration: 1, linkedGeneration: 1,
    });

    const { resubmitAadhaar } = await import('../../domains/telegram/telegramOnboarding.service.js');
    const res = await resubmitAadhaar({ userId: u._id, aadhaar: '888888888888' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_rejected');

    const kyc = await KycVerification.findOne({ userId: u._id }).lean();
    expect(kyc.aadhaarLast4, 'the verified Aadhaar is unchanged').toBe('7777');
  });
});

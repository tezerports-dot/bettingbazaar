// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The sign-in surface, against a REAL PostgreSQL.
 *
 * The properties here are the database's: at most one active generation, at
 * most one live bot per singular role (via a GENERATED column, so a plain
 * UPDATE cannot dodge it), one identity per Telegram account and per phone, and
 * a login token that exactly one of N racing redemptions can consume.
 *
 * Expiry gets its own attention throughout. The document model used TTL indexes
 * and these tables have none, so every read filters on `expires_at` — and the
 * tests below prove the reads do it rather than trusting the sweep, because a
 * sweep that is late must not make a bearer credential redeemable.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser } from '../repositories/users.js';
import {
  getActiveConfig, getActiveConfigSecrets, getActiveConfigWithSecrets,
  activateConfig, listConfigHistory,
  listBots, getLiveBot, getLiveBotSecrets, addBot, promoteBot, recordBotError,
  getTemplates, setTemplate, listTemplateRows, deleteTemplate,
  getIdentityByTelegramId, getIdentityByUserId, createIdentity, relinkIdentity,
  listIdentitiesForUser,
  setChannelStatus, deactivateContact,
  getPendingLink, getPendingAadhaar, upsertPendingLink, deletePendingLink,
  issueLoginToken, consumeLoginToken, sweepExpired,
} from '../repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

const bot = (over = {}) => ({
  botId: 'b1', label: 'primary', role: 'signin', username: '@bb_bot',
  tokenEncrypted: 'cipher', webhookSecret: 'secret', ...over,
});

describePg('the Telegram sign-in surface (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_login_tokens, telegram_pending_links,
                            telegram_identities, telegram_templates,
                            telegram_bots, telegram_configs, users
                   RESTART IDENTITY CASCADE`);
  });

  describe('configuration generations', () => {
    it('activates the first generation as number 1', async () => {
      const cfg = await activateConfig({ channelId: '-100123', reason: 'launch' });
      expect(cfg).toMatchObject({ generation: 1, channelId: '-100123', active: true });
      expect((await getActiveConfig()).generation).toBe(1);
    });

    it('a channel swap deactivates the old generation in the same transaction', async () => {
      await activateConfig({ channelId: '-100123' });
      const next = await activateConfig({ channelId: '-100456', reason: 'moved channel' });
      expect(next.generation).toBe(2);

      // The partial unique index is what makes "at most one active" the
      // DATABASE's rule rather than something every writer must remember.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_configs WHERE active');
      expect(rows[0].n).toBe(1);
      expect((await getActiveConfig()).channelId).toBe('-100456');
    });

    it('refuses a second active row written behind the repository', async () => {
      await activateConfig({ channelId: '-100123' });
      await expect(pgQuery(
        `INSERT INTO telegram_configs (generation, channel_id, active) VALUES (99, '-100999', TRUE)`,
      )).rejects.toThrow(/one_active_telegram_config/);
    });

    it('keeps bot secrets out of the ordinary read', async () => {
      await activateConfig({
        channelId: '-100123', botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
      const cfg = await getActiveConfig();
      expect(JSON.stringify(cfg)).not.toContain('TOKENCIPHER');
      expect(JSON.stringify(cfg)).not.toContain('HOOKSECRET');
      // Reachable only by asking for it by name.
      expect(await getActiveConfigSecrets()).toMatchObject({
        botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
    });

    it('reads the channel and its credentials in ONE statement', async () => {
      await activateConfig({
        channelId: '-100123', channelUsername: '@live', botUsername: 'bot',
        botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
      // The send path needs both halves, and reading them as two queries would
      // let a channel swap land between them — composing a config whose channel
      // belongs to one generation and whose token belongs to another.
      const cfg = await getActiveConfigWithSecrets();
      expect(cfg).toMatchObject({
        generation: 1,
        channelId: '-100123',
        channelUsername: '@live',
        botUsername: 'bot',
        botTokenEncrypted: 'TOKENCIPHER',
        webhookSecret: 'HOOKSECRET',
      });
    });

    it('answers null for the combined read before anything is configured', async () => {
      // The state a fresh deployment sits in. Callers must read it as "Telegram
      // auth is unavailable", never as an error to retry.
      expect(await getActiveConfigWithSecrets()).toBeNull();
    });

    it('lists generations newest first, with no token among them', async () => {
      await activateConfig({ channelId: '-1001', botTokenEncrypted: 'TOKENCIPHER' });
      await activateConfig({ channelId: '-1002' });
      await activateConfig({ channelId: '-1003' });

      const history = await listConfigHistory({ limit: 10 });
      expect(history.map((h) => h.generation)).toEqual([3, 2, 1]);
      // There is no read path for a bot token by design, and a history that
      // carried one would be exactly that.
      expect(JSON.stringify(history)).not.toContain('TOKENCIPHER');
    });
  });

  describe('the bot registry', () => {
    it('parks a new bot as STANDBY, which is the point of the table', async () => {
      expect(await addBot(bot())).toMatchObject({ status: 'STANDBY', liveSlot: null });
      expect(await getLiveBot('signin')).toBeNull();
    });

    it('derives live_slot from the row, so an UPDATE cannot dodge the rule', async () => {
      await addBot(bot({ status: 'ACTIVE' }));
      expect((await getLiveBot('signin')).botId).toBe('b1');

      await addBot(bot({ botId: 'b2', label: 'spare' }));
      // The model this replaces maintained the slot in a pre-validate hook,
      // which update operators bypassed entirely — so this exact statement
      // would have been accepted and left two live sign-in bots.
      await expect(pgQuery(`UPDATE telegram_bots SET status='ACTIVE' WHERE bot_id='b2'`))
        .rejects.toThrow(/one_live_bot_per_singular_role/);
    });

    it('allows any number of live OUTBOUND bots, which have no singular slot', async () => {
      await addBot(bot({ botId: 'c1', role: 'broadcast', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'c2', role: 'broadcast', status: 'ACTIVE' }));
      expect(await listBots({ role: 'broadcast', status: 'ACTIVE' })).toHaveLength(2);
    });

    it('promotes a standby and stands the incumbent down, atomically', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'spare' }));

      const result = await promoteBot({ botId: 'spare', role: 'signin', actor: 'admin-1' });
      expect(result.bot).toMatchObject({ botId: 'spare', status: 'ACTIVE', liveSlot: 'signin' });
      // The displaced bot comes back with it: the caller has to revoke the old
      // webhook once the transaction has committed, and it cannot do that from
      // a bot it was never told about.
      expect(result.displaced.bot).toMatchObject({ botId: 'live', status: 'STANDBY', liveSlot: null });
      expect(result.displaced.secrets.webhookSecret).toBeTruthy();

      // Never zero live bots at any point a reader could observe — the window
      // between the stand-down and the promotion is inside one transaction.
      expect(await getLiveBot('signin')).toMatchObject({ botId: 'spare' });
    });

    it('leaves the displaced bot promotable, so a bad promotion can be undone', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'spare' }));
      await promoteBot({ botId: 'spare', role: 'signin', actor: 'admin-1' });

      // RETIRED is a one-way door — `promote` refuses a retired bot outright —
      // so retiring the incumbent made every promotion irreversible: an operator
      // who promoted the wrong bot could not switch back, and the working bot
      // they had just displaced was gone for good.
      const back = await promoteBot({ botId: 'live', role: 'signin', actor: 'admin-1' });
      expect(back.bot).toMatchObject({ botId: 'live', status: 'ACTIVE' });
      expect(await getLiveBot('signin')).toMatchObject({ botId: 'live' });
    });

    it('refuses to promote a retired bot', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'gone', status: 'RETIRED' }));
      await expect(promoteBot({ botId: 'gone', role: 'signin' }))
        .rejects.toThrow(/no promotable bot gone/);
      expect(await getLiveBot('signin')).toMatchObject({ botId: 'live' });
    });

    it('leaves the incumbent live when the promotion target does not exist', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await expect(promoteBot({ botId: 'ghost', role: 'signin' }))
        .rejects.toThrow(/no promotable bot ghost/);
      // The stand-down half must have rolled back with it, or the platform is
      // left with nobody answering the webhook.
      expect(await getLiveBot('signin')).toMatchObject({ botId: 'live' });
    });

    it('keeps the token out of a listing and returns it only on request', async () => {
      await addBot(bot({ status: 'ACTIVE', tokenEncrypted: 'BOTCIPHER' }));
      expect(JSON.stringify(await listBots())).not.toContain('BOTCIPHER');
      expect(await getLiveBotSecrets('signin')).toMatchObject({ tokenEncrypted: 'BOTCIPHER' });
    });

    it('records why a promotion failed', async () => {
      await addBot(bot());
      await recordBotError('b1', 'Telegram: 401 Unauthorized');
      expect((await listBots())[0].lastError).toMatch(/401 Unauthorized/);
    });
  });

  describe('templates', () => {
    it('upserts by key', async () => {
      await setTemplate({ key: 'welcome', body: 'Hello' });
      await setTemplate({ key: 'welcome', body: 'Hello again' });
      expect(await getTemplates()).toEqual({ welcome: 'Hello again' });
    });

    it('treats a blank body as ABSENT so the caller falls back to the default', async () => {
      // An admin who clears the box means "use the shipped default", never
      // "send nothing" — a player staring at silence after /start is the worst
      // outcome this table can produce.
      await setTemplate({ key: 'welcome', body: '   ' });
      expect(await getTemplates()).toEqual({});
    });

    it('carries the edit metadata the admin screen needs', async () => {
      // getTemplates() answers only "what is the body". The panel also has to
      // show WHEN a key was last edited, which is why the row reader exists.
      await setTemplate({ key: 'welcome', body: 'Hi', updatedBy: 'admin-1' });
      const rows = await listTemplateRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'welcome', body: 'Hi', updatedBy: 'admin-1' });
      expect(rows[0].updatedAt).toBeInstanceOf(Date);
    });

    it('reverts a key by REMOVING the override, not by storing a blank one', async () => {
      // Two spellings of "use the default" would mean every read has to handle
      // both, and the one that forgets sends an empty message.
      await setTemplate({ key: 'welcome', body: 'Hi' });
      expect(await deleteTemplate('welcome')).toEqual({ removed: true });
      expect(await listTemplateRows()).toEqual([]);
      expect(await getTemplates()).toEqual({});
    });

    it('reports a no-op revert rather than failing', async () => {
      // Reverting a key that was never customised is an admin clicking twice,
      // not an error.
      expect(await deleteTemplate('welcome')).toEqual({ removed: false });
    });
  });

  describe('identities', () => {
    beforeEach(async () => {
      await createUser({ userId: 'u-1', username: 'a', mobile: '9990000001' });
      await createUser({ userId: 'u-2', username: 'b', mobile: '9990000002' });
    });

    it('links a Telegram account to a platform account', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      expect((await getIdentityByTelegramId('t-1')).userId).toBe('u-1');
      expect((await getIdentityByUserId('u-1')).telegramUserId).toBe('t-1');
    });

    it('refuses a second platform account for one Telegram account', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(createIdentity({ telegramUserId: 't-1', userId: 'u-2', phone: '9990000002' }))
        .rejects.toThrow(/telegram_identities_pkey/);
    });

    it('refuses a second Telegram account for one platform account', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(createIdentity({ telegramUserId: 't-2', userId: 'u-1', phone: '9990000002' }))
        .rejects.toThrow(/one_active_identity_per_user/);
    });

    it('refuses two ACTIVE identities on one phone — the anchor rule', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9998887777' });
      await expect(createIdentity({ telegramUserId: 't-2', userId: 'u-2', phone: '9998887777' }))
        .rejects.toThrow(/one_active_identity_per_phone/);
    });

    it('frees the phone once the old claim is retired, for the recovery path', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9998887777' });
      // The row SURVIVES, marked: "was this number ever linked, and to whom?"
      // is what a recovery request asks.
      const retired = await deactivateContact('t-1');
      expect(retired.contactActive).toBe(false);

      await createIdentity({ telegramUserId: 't-2', userId: 'u-2', phone: '9998887777' });
      expect((await getIdentityByTelegramId('t-2')).userId).toBe('u-2');
      expect(await getIdentityByTelegramId('t-1')).not.toBeNull();
    });

    it('stores the generation WITH the cached membership', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      const seen = await setChannelStatus('t-1', { status: 'member', generation: 3 });
      expect(seen).toMatchObject({ channelStatus: 'member', channelGeneration: 3 });
      // A channel swap bumps the generation, which makes this observation stale
      // BY CONSTRUCTION rather than by a sweep somebody has to run.
      expect(seen.channelGeneration).not.toBe(4);
    });

    it('refuses a channel status the table does not recognise', async () => {
      await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(setChannelStatus('t-1', { status: 'vibing', generation: 1 }))
        .rejects.toThrow(/channel_status_check/);
    });
  });

  describe('pending onboardings', () => {
    it('advances a step without erasing what an earlier step captured', async () => {
      await upsertPendingLink({
        telegramUserId: 't-1', step: 'AWAITING_CONTACT',
        aadhaarHash: 'h1', aadhaarEncrypted: 'c1', aadhaarLast4: '1234',
        referralCode: 'ALICE1',
      });
      // The contact step sends no Aadhaar. Overwriting with NULL would lose the
      // number the conversation already proved.
      await upsertPendingLink({
        telegramUserId: 't-1', step: 'AWAITING_CHANNEL', phone: '9990000001',
      });
      expect(await getPendingLink('t-1')).toMatchObject({
        step: 'AWAITING_CHANNEL', aadhaarHash: 'h1', aadhaarLast4: '1234',
        phone: '9990000001', referralCode: 'ALICE1',
      });
    });

    it('keeps the Aadhaar ciphertext out of the ordinary read', async () => {
      await upsertPendingLink({
        telegramUserId: 't-1', aadhaarHash: 'h1', aadhaarEncrypted: 'AADHAARCIPHER',
      });
      expect(JSON.stringify(await getPendingLink('t-1'))).not.toContain('AADHAARCIPHER');
      expect(await getPendingAadhaar('t-1')).toMatchObject({ aadhaarEncrypted: 'AADHAARCIPHER' });
    });

    it('an EXPIRED onboarding is not readable, even before the sweep runs', async () => {
      await upsertPendingLink({ telegramUserId: 't-1', aadhaarHash: 'h1' });
      await pgQuery(`UPDATE telegram_pending_links SET expires_at = now() - interval '1 second'`);

      // The row is still THERE — nothing has swept it — and it must already be
      // unusable. A caller that trusted the sweep would resume a conversation
      // whose Aadhaar hash is past its retention window.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_pending_links');
      expect(rows[0].n).toBe(1);
      expect(await getPendingLink('t-1')).toBeNull();
      expect(await getPendingAadhaar('t-1')).toBeNull();
    });

    it('restarting resets the expiry rather than inheriting the abandoned one', async () => {
      await upsertPendingLink({ telegramUserId: 't-1', ttlHours: 24 });
      await pgQuery(`UPDATE telegram_pending_links SET expires_at = now() + interval '1 minute'`);
      await upsertPendingLink({ telegramUserId: 't-1', ttlHours: 24 });
      const { rows } = await pgQuery(
        `SELECT expires_at > now() + interval '20 hours' AS fresh FROM telegram_pending_links`);
      expect(rows[0].fresh).toBe(true);
    });

    it('deletes cleanly once it has produced an identity', async () => {
      await upsertPendingLink({ telegramUserId: 't-1' });
      await deletePendingLink('t-1');
      expect(await getPendingLink('t-1')).toBeNull();
    });
  });

  describe('login tokens — a bearer credential', () => {
    beforeEach(async () => {
      await createUser({ userId: 'u-1', username: 'a', mobile: '9990000001' });
    });

    it('is consumed exactly once', async () => {
      await issueLoginToken({ tokenHash: 'h1', telegramUserId: 't-1', userId: 'u-1' });
      expect(await consumeLoginToken({ tokenHash: 'h1' })).toMatchObject({ userId: 'u-1' });
      // A forwarded link redeemed twice must not mint a second session.
      expect(await consumeLoginToken({ tokenHash: 'h1' })).toBeNull();
    });

    it('exactly one of 20 racing redemptions wins', async () => {
      await issueLoginToken({ tokenHash: 'h1', telegramUserId: 't-1', userId: 'u-1' });
      const results = await Promise.all(
        Array.from({ length: 20 }, () => consumeLoginToken({ tokenHash: 'h1' })));
      // The read and the consume are ONE atomic UPDATE. Check-then-consume is
      // two statements, and a race fits between them.
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('refuses an EXPIRED token before any sweep has run', async () => {
      await issueLoginToken({ tokenHash: 'h1', telegramUserId: 't-1', userId: 'u-1', ttlSeconds: 1 });
      await pgQuery(`UPDATE telegram_login_tokens SET expires_at = now() - interval '1 second'`);
      expect(await consumeLoginToken({ tokenHash: 'h1' })).toBeNull();
      // Still present — the read decided, not the sweep.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_login_tokens');
      expect(rows[0].n).toBe(1);
    });

    it('refuses a token presented by a different Telegram account', async () => {
      await issueLoginToken({ tokenHash: 'h1', telegramUserId: 't-1', userId: 'u-1' });
      expect(await consumeLoginToken({ tokenHash: 'h1', telegramUserId: 't-999' })).toBeNull();
      // …and the legitimate holder can still use it.
      expect(await consumeLoginToken({ tokenHash: 'h1', telegramUserId: 't-1' })).toMatchObject({ userId: 'u-1' });
    });

    it('answers unknown, used and expired identically', async () => {
      // Otherwise the endpoint tells an attacker which of their guesses was a
      // real token.
      await issueLoginToken({ tokenHash: 'used', telegramUserId: 't-1', userId: 'u-1' });
      await consumeLoginToken({ tokenHash: 'used' });
      await issueLoginToken({ tokenHash: 'gone', telegramUserId: 't-1', userId: 'u-1' });
      await pgQuery(`UPDATE telegram_login_tokens SET expires_at = now() - interval '1 s' WHERE token_hash='gone'`);

      expect(await consumeLoginToken({ tokenHash: 'never-existed' })).toBeNull();
      expect(await consumeLoginToken({ tokenHash: 'used' })).toBeNull();
      expect(await consumeLoginToken({ tokenHash: 'gone' })).toBeNull();
    });
  });

  describe('the sweep reclaims space and decides nothing', () => {
    it('removes only expired rows, and counts what it actually deleted', async () => {
      await createUser({ userId: 'u-1', username: 'a', mobile: '9990000001' });
      await upsertPendingLink({ telegramUserId: 't-live' });
      await upsertPendingLink({ telegramUserId: 't-dead' });
      await pgQuery(`UPDATE telegram_pending_links SET expires_at = now() - interval '1 s'
                      WHERE telegram_user_id = 't-dead'`);
      await issueLoginToken({ tokenHash: 'live', telegramUserId: 't-1', userId: 'u-1' });
      await issueLoginToken({ tokenHash: 'dead', telegramUserId: 't-1', userId: 'u-1' });
      await pgQuery(`UPDATE telegram_login_tokens SET expires_at = now() - interval '1 s'
                      WHERE token_hash = 'dead'`);

      expect(await sweepExpired()).toEqual({ pendingLinks: 1, loginTokens: 1 });
      expect(await getPendingLink('t-live')).not.toBeNull();
      // Reconstructed per pass: a second pass finds nothing, rather than
      // reporting a total it accumulated.
      expect(await sweepExpired()).toEqual({ pendingLinks: 0, loginTokens: 0 });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signup: the only way a player account comes into being.
// ─────────────────────────────────────────────────────────────────────────────
import { createAccountFromOnboarding } from '../repositories/telegram.js';
import { getUser, newUserId } from '../repositories/users.js';
import { getVerification, isAadhaarRegistered } from '../repositories/identity.js';

const signup = (over = {}) => ({
  telegramUserId: 't-1', mobile: '9990001111', username: 'newplayer',
  aadhaarHash: 'ah-1', aadhaarEncrypted: 'ac-1', aadhaarLast4: '4321',
  newUserId: newUserId(), ...over,
});

describePg('signup (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE kyc_verifications, telegram_identities, users
                   RESTART IDENTITY CASCADE`);
  });

  it('writes the account, the identity and the Aadhaar together', async () => {
    const r = await createAccountFromOnboarding(signup());
    expect(r.ok).toBe(true);

    const user = await getUser(r.userId);
    expect(user).toMatchObject({
      mobile: '9990001111', status: 'ACTIVE', kycStatus: 'PENDING_APPROVAL',
      // The signup IS submission one. Counted in the same INSERT, so the
      // reapply cap cannot silently allow one more attempt than it advertises.
      kycSubmissionCount: 1,
    });
    expect((await getIdentityByTelegramId('t-1')).userId).toBe(r.userId);
    expect((await getVerification(r.userId)).status).toBe('PENDING_VERIFICATION');
  });

  it('leaves NOTHING behind when the Aadhaar is already registered', async () => {
    await createAccountFromOnboarding(signup());
    const second = await createAccountFromOnboarding(signup({
      telegramUserId: 't-2', mobile: '9990002222', newUserId: newUserId(),
    }));
    expect(second).toEqual({ ok: false, reason: 'aadhaar_taken' });

    // The account and identity inserts came FIRST in the transaction, so a
    // partial signup here would leave an account nobody can sign into and a
    // number that can never be registered again.
    const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM users`);
    expect(rows[0].n).toBe(1);
    expect(await getIdentityByTelegramId('t-2')).toBeNull();
  });

  it('leaves nothing behind when the phone is already linked', async () => {
    await createAccountFromOnboarding(signup());
    const second = await createAccountFromOnboarding(signup({
      telegramUserId: 't-2', aadhaarHash: 'ah-2', aadhaarEncrypted: 'ac-2',
      newUserId: newUserId(),
    }));
    // Same mobile, so the account insert conflicts first.
    expect(second.ok).toBe(false);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
    expect(await isAadhaarRegistered('ah-2')).toBe(false);
  });

  it('reports a redelivered update as a duplicate rather than crashing', async () => {
    await createAccountFromOnboarding(signup());
    // Telegram redelivers. The same person, the same everything.
    expect(await createAccountFromOnboarding(signup({ newUserId: newUserId() })))
      .toEqual({ ok: false, reason: 'duplicate' });
  });

  it('10 concurrent completions of one onboarding produce ONE account', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      createAccountFromOnboarding(signup({ newUserId: newUserId() })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM kyc_verifications`)).rows[0].n).toBe(1);
  });

  it('carries the referral attribution captured at first contact', async () => {
    const first = await createAccountFromOnboarding(signup({ referralCode: 'ALICE1' }));
    const second = await createAccountFromOnboarding(signup({
      telegramUserId: 't-2', mobile: '9990002222', aadhaarHash: 'ah-2',
      aadhaarEncrypted: 'ac-2', referredBy: first.userId, newUserId: newUserId(),
    }));
    expect((await getUser(second.userId)).referredBy).toBe(first.userId);
  });

  it('gives each account an unpredictable id, not one derived from the phone', async () => {
    // Account ids travel in URLs and payloads. An id computable from a phone
    // number would let anyone holding the number address the account.
    const r = await createAccountFromOnboarding(signup());
    expect(r.userId).toMatch(/^[0-9a-f]{24}$/);
    expect(r.userId).not.toContain('9990001111');
    expect(newUserId()).not.toBe(newUserId());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Account recovery — handing an account to a DIFFERENT Telegram identity.
//
// Every assertion here is about a constraint that must not be briefly violated.
// The swap satisfies three unique indexes at once: the account's identity, the
// phone's active slot, and the Telegram id itself.
// ─────────────────────────────────────────────────────────────────────────────
describePg('recovering an account onto a new Telegram identity', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE telegram_identities, users RESTART IDENTITY CASCADE');
    // The identity's user_id is a foreign key: an identity cannot point at an
    // account that does not exist, which is the constraint that stops a
    // recovery from linking a Telegram account to nothing.
    await createUser({ userId: 'u-1', username: 'a', mobile: '9990000001' });
    await createUser({ userId: 'u-2', username: 'b', mobile: '9990000002' });
    await createUser({ userId: 'u-9', username: 'i', mobile: '9990000009' });
  });

  it('moves the account to the new identity and stands the old one down', async () => {
    await createIdentity({ telegramUserId: 't-old', userId: 'u-1', phone: '9990000001' });

    const result = await relinkIdentity({
      telegramUserId: 't-new', userId: 'u-1', phone: '9990000001', generation: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.identity).toMatchObject({ telegramUserId: 't-new', userId: 'u-1' });
    // Which identity LOST the account — the detail a takeover review needs.
    expect(result.displacedTelegramUserId).toBe('t-old');

    // The account resolves to the new identity. An unfiltered read would
    // return whichever row the planner reached first — usually the OLD one —
    // and messaging the identity that just lost the account is the failure
    // recovery exists to prevent.
    expect(await getIdentityByUserId('u-1')).toMatchObject({ telegramUserId: 't-new' });

    // The displaced row SURVIVES as history rather than being deleted. It is
    // the first thing a takeover review asks for.
    const old = await getIdentityByTelegramId('t-old');
    expect(old.contactActive).toBe(false);
    expect(old.channelStatus).toBe('left');
    expect(old.userId).toBe('u-1');
    expect((await listIdentitiesForUser('u-1')).map((i) => i.telegramUserId).sort())
      .toEqual(['t-new', 't-old']);
  });

  it('frees the phone slot, so the new identity can claim the same number', async () => {
    await createIdentity({ telegramUserId: 't-old', userId: 'u-1', phone: '9990000001' });
    // `one_active_identity_per_phone` is partial on contact_active. Two steps
    // would either be refused outright or leave the account with no active
    // identity between them.
    const result = await relinkIdentity({
      telegramUserId: 't-new', userId: 'u-1', phone: '9990000001',
    });
    expect(result.ok).toBe(true);
    expect(result.identity.contactActive).toBe(true);
  });

  it('refuses to hand a second account to one Telegram identity', async () => {
    await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
    await createIdentity({ telegramUserId: 't-2', userId: 'u-2', phone: '9990000002' });

    // t-2 already holds u-2. Giving it u-1 as well would create exactly the
    // duplicate the design exists to prevent — and it is a REFUSAL rather than
    // a thrown duplicate-key error, so the caller answers with a message.
    const result = await relinkIdentity({
      telegramUserId: 't-2', userId: 'u-1', phone: '9990000001',
    });
    expect(result).toEqual({ ok: false, reason: 'TELEGRAM_ALREADY_LINKED' });

    // Nothing moved.
    expect(await getIdentityByUserId('u-1')).toMatchObject({ telegramUserId: 't-1' });
    expect(await getIdentityByUserId('u-2')).toMatchObject({ telegramUserId: 't-2' });
  });

  it('is idempotent when the same identity asks twice', async () => {
    await createIdentity({ telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
    const again = await relinkIdentity({
      telegramUserId: 't-1', userId: 'u-1', phone: '9990000001',
    });
    // The same Telegram account re-points its own row rather than colliding
    // with itself, and displaces nobody.
    expect(again.ok).toBe(true);
    expect(again.displacedTelegramUserId).toBeNull();
    expect(await getIdentityByUserId('u-1')).toMatchObject({ telegramUserId: 't-1' });
  });

  it('links a first identity when the account has none', async () => {
    const first = await relinkIdentity({
      telegramUserId: 't-fresh', userId: 'u-9', phone: '9990000009',
    });
    expect(first.ok).toBe(true);
    // A recovery that displaced nobody is a first link, not a recovery — and
    // the caller can tell the two apart.
    expect(first.displacedTelegramUserId).toBeNull();
  });
});

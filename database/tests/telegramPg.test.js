// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
  sweepExpired, putRecoverySession, getRecoverySession,
  retireBot, assignSigninBot, signinBotLoads, linkTelegramToAccount,
} from '../repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

const bot = (over = {}) => ({
  botId: 'b1', label: 'primary', role: 'signin', audience: 'PLAYER', username: '@bb_bot',
  tokenEncrypted: 'cipher', webhookSecret: 'secret', ...over,
});

describePg('the Telegram sign-in surface (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_identities, telegram_templates,
                            telegram_bots, telegram_configs, users
                   RESTART IDENTITY CASCADE`);
    // The rotation cursor is a SEQUENCE, so TRUNCATE does not touch it. Reset
    // it here or the cycle starts wherever the previous suite left it and
    // `assignSigninBot` reads as non-deterministic — which is the shape of
    // §32 S19, a test asserting a precondition it never established.
    await pgQuery(`SELECT setval('telegram_signin_rotation', 1, false)`);
  });

  describe('configuration generations', () => {
    it('activates the first generation as number 1', async () => {
      const cfg = await activateConfig({ audience: 'PLAYER', channelId: '-100123', reason: 'launch' });
      expect(cfg).toMatchObject({ generation: 1, channelId: '-100123', active: true });
      expect((await getActiveConfig('PLAYER')).generation).toBe(1);
    });

    it('a channel swap deactivates the old generation in the same transaction', async () => {
      await activateConfig({ audience: 'PLAYER', channelId: '-100123' });
      const next = await activateConfig({ audience: 'PLAYER', channelId: '-100456', reason: 'moved channel' });
      expect(next.generation).toBe(2);

      // The partial unique index is what makes "at most one active" the
      // DATABASE's rule rather than something every writer must remember.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_configs WHERE active');
      expect(rows[0].n).toBe(1);
      expect((await getActiveConfig('PLAYER')).channelId).toBe('-100456');
    });

    it('refuses a second active row written behind the repository', async () => {
      await activateConfig({ audience: 'PLAYER', channelId: '-100123' });
      await expect(pgQuery(
        `INSERT INTO telegram_configs (generation, channel_id, active) VALUES (99, '-100999', TRUE)`,
      )).rejects.toThrow(/one_active_telegram_config/);
    });

    it('keeps bot secrets out of the ordinary read', async () => {
      await activateConfig({ audience: 'PLAYER',
        channelId: '-100123', botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
      const cfg = await getActiveConfig('PLAYER');
      expect(JSON.stringify(cfg)).not.toContain('TOKENCIPHER');
      expect(JSON.stringify(cfg)).not.toContain('HOOKSECRET');
      // Reachable only by asking for it by name.
      expect(await getActiveConfigSecrets('PLAYER')).toMatchObject({
        botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
    });

    it('reads the channel and its credentials in ONE statement', async () => {
      await activateConfig({ audience: 'PLAYER',
        channelId: '-100123', channelUsername: '@live', botUsername: 'bot',
        botTokenEncrypted: 'TOKENCIPHER', webhookSecret: 'HOOKSECRET',
      });
      // The send path needs both halves, and reading them as two queries would
      // let a channel swap land between them — composing a config whose channel
      // belongs to one generation and whose token belongs to another.
      const cfg = await getActiveConfigWithSecrets('PLAYER');
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
      expect(await getActiveConfigWithSecrets('PLAYER')).toBeNull();
    });

    it('lists generations newest first, with no token among them', async () => {
      await activateConfig({ audience: 'PLAYER', channelId: '-1001', botTokenEncrypted: 'TOKENCIPHER' });
      await activateConfig({ audience: 'PLAYER', channelId: '-1002' });
      await activateConfig({ audience: 'PLAYER', channelId: '-1003' });

      const history = await listConfigHistory({ limit: 10 });
      expect(history.map((h) => h.generation)).toEqual([3, 2, 1]);
      // There is no read path for a bot token by design, and a history that
      // carried one would be exactly that.
      expect(JSON.stringify(history)).not.toContain('TOKENCIPHER');
    });
  });

  describe('one active channel PER PANEL', () => {
    it('activating one panel leaves the others alone', async () => {
      // THE expensive mistake this scoping exists to stop. A cached membership
      // is stamped with the generation it was observed in, so deactivating the
      // player generation makes every player's cached answer stale at once —
      // the entire user base re-gated, at the moment an operator believed they
      // were configuring a different panel entirely.
      const player = await activateConfig({ audience: 'PLAYER', channelId: '-100111' });
      const merchant = await activateConfig({ audience: 'MERCHANT', channelId: '-100222' });
      const staff = await activateConfig({ audience: 'STAFF', channelId: '-100333' });

      expect((await getActiveConfig('PLAYER')).channelId).toBe('-100111');
      expect((await getActiveConfig('MERCHANT')).channelId).toBe('-100222');
      expect((await getActiveConfig('STAFF')).channelId).toBe('-100333');

      // Generations stay GLOBALLY unique across the three, which is what makes
      // a cross-panel stale answer unrepresentable rather than merely unlikely:
      // a merchant's cached generation can never compare equal to the player
      // channel's current one.
      expect(new Set([player.generation, merchant.generation, staff.generation]).size).toBe(3);
    });

    it('replacing one panel’s channel re-gates only that panel', async () => {
      await activateConfig({ audience: 'PLAYER', channelId: '-100111' });
      const before = (await getActiveConfig('PLAYER')).generation;
      await activateConfig({ audience: 'MERCHANT', channelId: '-100222' });
      await activateConfig({ audience: 'MERCHANT', channelId: '-100999', reason: 'moved' });

      // The player generation did not move, so no player is asked to re-join.
      expect((await getActiveConfig('PLAYER')).generation).toBe(before);
      expect((await getActiveConfig('MERCHANT')).channelId).toBe('-100999');
    });

    it('answers null for a panel nobody has configured', async () => {
      // The state the STAFF bootstrap exemption exists for, asserted here as a
      // plain fact about the store: a configured player channel says nothing
      // about whether staff have one.
      await activateConfig({ audience: 'PLAYER', channelId: '-100111' });
      expect(await getActiveConfig('STAFF')).toBeNull();
      expect(await getActiveConfigWithSecrets('STAFF')).toBeNull();
    });
  });

  describe('the bot registry', () => {
    it('parks a new bot as STANDBY, which is the point of the table', async () => {
      expect(await addBot(bot())).toMatchObject({ status: 'STANDBY', liveSlot: null });
      expect(await getLiveBot('signin', 'PLAYER')).toBeNull();
    });

    it('leaves live_slot NULL for a sign-in bot, because the role is a FLEET', async () => {
      // Stated as its own assertion because it is the schema change the whole
      // fleet rests on, and it is invisible from any behaviour above.
      expect(await addBot(bot({ status: 'ACTIVE' }))).toMatchObject({ liveSlot: null });
      // The slot composes the AUDIENCE in, which is what makes "one live
      // recovery bot" a rule about one PANEL rather than about the platform.
      expect(await addBot(bot({ botId: 'r', role: 'recovery', status: 'ACTIVE' })))
        .toMatchObject({ liveSlot: 'PLAYER:recovery' });
    });

    it('derives live_slot from the row, so an UPDATE cannot dodge the rule', async () => {
      // RECOVERY, not sign-in. Sign-in became a fleet on 2026-09-23 and this
      // test was asserting the singular rule against it — which would now fail
      // for the right reason and be read as a regression. Recovery is still
      // singular, and for a reason worth stating: it is the one path that hands
      // an account to a DIFFERENT Telegram account, so it stays one door.
      await addBot(bot({ botId: 'r1', role: 'recovery', status: 'ACTIVE' }));
      expect((await getLiveBot('recovery', 'PLAYER')).botId).toBe('r1');

      await addBot(bot({ botId: 'r2', role: 'recovery', label: 'spare' }));
      // The model this replaces maintained the slot in a pre-validate hook,
      // which update operators bypassed entirely — so this exact statement
      // would have been accepted and left two live recovery bots.
      await expect(pgQuery(`UPDATE telegram_bots SET status='ACTIVE' WHERE bot_id='r2'`))
        .rejects.toThrow(/one_live_bot_per_singular_role/);
    });

    it('serves A live sign-in bot for the channel questions, deterministically', async () => {
      // `getLiveBot('signin', 'PLAYER')` no longer reads the generated column, because
      // for a fleet that column is always NULL and the read would answer "not
      // configured" over a working fleet. It answers "give me one", ordered, and
      // which one does not matter: it is read to ask Telegram about the CHANNEL
      // and to resolve a @username, never to decide whose conversation is whose.
      await addBot(bot({ botId: 'z2', status: 'ACTIVE' }));
      await pgQuery(`UPDATE telegram_bots SET added_at = now() + interval '5 s' WHERE bot_id='z2'`);
      await addBot(bot({ botId: 'z1', status: 'ACTIVE' }));
      expect((await getLiveBot('signin', 'PLAYER')).botId).toBe('z1');
      expect((await getLiveBotSecrets('signin', 'PLAYER')).botId).toBe('z1');
    });

    it('allows any number of live OUTBOUND bots, which have no singular slot', async () => {
      await addBot(bot({ botId: 'c1', role: 'broadcast', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'c2', role: 'broadcast', status: 'ACTIVE' }));
      expect(await listBots({ role: 'broadcast', status: 'ACTIVE' })).toHaveLength(2);
    });

    it('promotes a standby and stands the incumbent down, atomically', async () => {
      // RECOVERY. Sign-in is a fleet now, where promoting a spare displaces
      // NOTHING — that is the point of a fleet — so this test would have
      // asserted the fleet's correct behaviour as a failure. The atomic
      // stand-down is still the rule for every SINGULAR role, and recovery is
      // the singular role that remains.
      await addBot(bot({ botId: 'live', role: 'recovery', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'spare', role: 'recovery' }));

      const result = await promoteBot({ botId: 'spare', role: 'recovery', actor: 'admin-1' });
      expect(result.bot).toMatchObject({ botId: 'spare', status: 'ACTIVE', liveSlot: 'PLAYER:recovery' });
      // The displaced bot comes back with it: the caller has to revoke the old
      // webhook once the transaction has committed, and it cannot do that from
      // a bot it was never told about.
      expect(result.displaced.bot).toMatchObject({ botId: 'live', status: 'STANDBY', liveSlot: null });
      expect(result.displaced.secrets.webhookSecret).toBeTruthy();

      // Never zero live bots at any point a reader could observe — the window
      // between the stand-down and the promotion is inside one transaction.
      expect(await getLiveBot('recovery', 'PLAYER')).toMatchObject({ botId: 'spare' });
    });

    it('promoting a sign-in bot displaces NOBODY, because they all serve', async () => {
      // The fleet's defining behaviour, and the one an operator adding their
      // hundredth bot is relying on: promoting it must not stand down the
      // ninety-nine that are already carrying players.
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'spare' }));

      const result = await promoteBot({ botId: 'spare', role: 'signin', actor: 'admin-1' });
      expect(result.bot).toMatchObject({ botId: 'spare', status: 'ACTIVE', liveSlot: null });
      expect(result.displaced).toBeNull();
      expect(await listBots({ role: 'signin', status: 'ACTIVE' })).toHaveLength(2);
    });

    it('leaves the displaced bot promotable, so a bad promotion can be undone', async () => {
      await addBot(bot({ botId: 'live', role: 'recovery', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'spare', role: 'recovery' }));
      await promoteBot({ botId: 'spare', role: 'recovery', actor: 'admin-1' });

      // RETIRED is a one-way door — `promote` refuses a retired bot outright —
      // so retiring the incumbent made every promotion irreversible: an operator
      // who promoted the wrong bot could not switch back, and the working bot
      // they had just displaced was gone for good.
      const back = await promoteBot({ botId: 'live', role: 'recovery', actor: 'admin-1' });
      expect(back.bot).toMatchObject({ botId: 'live', status: 'ACTIVE' });
      expect(await getLiveBot('recovery', 'PLAYER')).toMatchObject({ botId: 'live' });
    });

    it('refuses to promote a retired bot', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await addBot(bot({ botId: 'gone', status: 'RETIRED' }));
      await expect(promoteBot({ botId: 'gone', role: 'signin' }))
        .rejects.toThrow(/no promotable bot gone/);
      expect(await getLiveBot('signin', 'PLAYER')).toMatchObject({ botId: 'live' });
    });

    it('leaves the incumbent live when the promotion target does not exist', async () => {
      await addBot(bot({ botId: 'live', status: 'ACTIVE' }));
      await expect(promoteBot({ botId: 'ghost', role: 'signin' }))
        .rejects.toThrow(/no promotable bot ghost/);
      // The stand-down half must have rolled back with it, or the platform is
      // left with nobody answering the webhook.
      expect(await getLiveBot('signin', 'PLAYER')).toMatchObject({ botId: 'live' });
    });

    it('keeps the token out of a listing and returns it only on request', async () => {
      await addBot(bot({ status: 'ACTIVE', tokenEncrypted: 'BOTCIPHER' }));
      expect(JSON.stringify(await listBots())).not.toContain('BOTCIPHER');
      expect(await getLiveBotSecrets('signin', 'PLAYER')).toMatchObject({ tokenEncrypted: 'BOTCIPHER' });
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

    it('lets ONE Telegram account hold one link per panel', async () => {
      // The thing a bare `telegram_user_id` primary key made impossible. One
      // person opens all three bots from the same Telegram account — that is
      // what a Telegram account IS — and before the key was widened the second
      // share was refused with "this Telegram account is already verifying a
      // different account", naming the link they had made minutes earlier.
      await createUser({ userId: 'm-1', username: 'm', mobile: '9990000001', accountType: 'MERCHANT' });
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await createIdentity({ audience: 'MERCHANT', telegramUserId: 't-1', userId: 'm-1', phone: '9990000001' });

      expect((await getIdentityByTelegramId('t-1', 'PLAYER')).userId).toBe('u-1');
      expect((await getIdentityByTelegramId('t-1', 'MERCHANT')).userId).toBe('m-1');
      // And the panel that was never linked still answers null, rather than
      // handing back whichever of the two the planner reached first.
      expect(await getIdentityByTelegramId('t-1', 'STAFF')).toBeNull();
    });

    it('still refuses a second Telegram account for one panel', async () => {
      // Widening the key must not widen the RULE. Within one audience the old
      // invariant is untouched.
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(createIdentity({
        audience: 'PLAYER', telegramUserId: 't-2', userId: 'u-1', phone: '9990000009',
      })).rejects.toMatchObject({ code: '23505' });
    });

    it('lets one mobile be proven on each panel, and only once per panel', async () => {
      await createUser({ userId: 'm-1', username: 'm', mobile: '9998887777', accountType: 'MERCHANT' });
      await createUser({ userId: 'u-3', username: 'c', mobile: '9998887777' });
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-3', phone: '9998887777' });
      // A different panel, same number: allowed, because they are different
      // accounts (§33.5) and the person holds the phone for both.
      await createIdentity({ audience: 'MERCHANT', telegramUserId: 't-2', userId: 'm-1', phone: '9998887777' });
      // A second ACTIVE claim on the same number WITHIN a panel: still refused.
      await expect(createIdentity({
        audience: 'MERCHANT', telegramUserId: 't-3', userId: 'u-2', phone: '9998887777',
      })).rejects.toMatchObject({ code: '23505' });
    });

    it('links a Telegram account to a platform account', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      expect((await getIdentityByTelegramId('t-1', 'PLAYER')).userId).toBe('u-1');
      expect((await getIdentityByUserId('u-1')).telegramUserId).toBe('t-1');
    });

    it('refuses a second platform account for one Telegram account', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-2', phone: '9990000002' }))
        .rejects.toThrow(/telegram_identities_pkey/);
    });

    it('refuses a second Telegram account for one platform account', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(createIdentity({ audience: 'PLAYER', telegramUserId: 't-2', userId: 'u-1', phone: '9990000002' }))
        .rejects.toThrow(/one_active_identity_per_user/);
    });

    it('refuses two ACTIVE identities on one phone — the anchor rule', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9998887777' });
      await expect(createIdentity({ audience: 'PLAYER', telegramUserId: 't-2', userId: 'u-2', phone: '9998887777' }))
        .rejects.toThrow(/one_active_identity_per_phone/);
    });

    it('frees the phone once the old claim is retired, for the recovery path', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9998887777' });
      // The row SURVIVES, marked: "was this number ever linked, and to whom?"
      // is what a recovery request asks.
      const retired = await deactivateContact('t-1', 'PLAYER');
      expect(retired.contactActive).toBe(false);

      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-2', userId: 'u-2', phone: '9998887777' });
      expect((await getIdentityByTelegramId('t-2', 'PLAYER')).userId).toBe('u-2');
      expect(await getIdentityByTelegramId('t-1', 'PLAYER')).not.toBeNull();
    });

    it('stores the generation WITH the cached membership', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      const seen = await setChannelStatus('t-1', { audience: 'PLAYER', status: 'member', generation: 3 });
      expect(seen).toMatchObject({ channelStatus: 'member', channelGeneration: 3 });
      // A channel swap bumps the generation, which makes this observation stale
      // BY CONSTRUCTION rather than by a sweep somebody has to run.
      expect(seen.channelGeneration).not.toBe(4);
    });

    it('refuses a channel status the table does not recognise', async () => {
      await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
      await expect(setChannelStatus('t-1', { audience: 'PLAYER', status: 'vibing', generation: 1 }))
        .rejects.toThrow(/channel_status_check/);
    });
  });

  // ── Pending onboardings, login tokens and login codes ────────────────────
  //
  // Three suites, about sixty assertions, deleted with the tables they tested
  // (2026-09-23). They covered a conversation that collected an Aadhaar number
  // and a bot that handed out one-time links and six-digit codes. The form
  // creates the account now and the player has a password, so none of it
  // exists — and a suite asserting the absent behaviour of a deleted table is
  // not coverage, it is a failing build with a misleading message.
  //
  // What replaced them, in this file: the FLEET suite below (rotation,
  // reassignment, the last-bot refusal) and `linking a Telegram account to an
  // account that ALREADY EXISTS`, which is the one thing the contact share now
  // does. `backend/tests/routes/playerAuthRoutes.test.js` covers the form.

  describe('a contact share reaches ONLY the panel its bot serves', () => {
    beforeEach(async () => {
      // One mobile, three accounts — the shape §33.5 made legal and the shape
      // §32 S30 says a query will eventually resolve wrongly.
      await createUser({ userId: 'pl', username: 'pl', mobile: '9990004444' });
      await createUser({ userId: 'me', username: 'me', mobile: '9990004444', accountType: 'MERCHANT' });
      await createUser({ userId: 'st', username: 'st', mobile: '9990004444', accountType: 'STAFF' });
    });

    it('links the account of the BOT’S OWN type, not whichever row comes first', async () => {
      expect(await linkTelegramToAccount({ audience: 'MERCHANT', telegramUserId: 't-m', phone: '9990004444' }))
        .toMatchObject({ ok: true, userId: 'me' });
      expect(await linkTelegramToAccount({ audience: 'STAFF', telegramUserId: 't-s', phone: '9990004444' }))
        .toMatchObject({ ok: true, userId: 'st' });
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-p', phone: '9990004444' }))
        .toMatchObject({ ok: true, userId: 'pl' });
    });

    it('answers no_account when that panel has no account on the number', async () => {
      // Not "already linked", and not somebody else's row. A merchant bot
      // meeting a number that only has a player account must say the merchant
      // form has not been filled in — which is a sentence the person can act on.
      await pgQuery(`DELETE FROM users WHERE user_id IN ('me','st')`);
      expect(await linkTelegramToAccount({ audience: 'MERCHANT', telegramUserId: 't-m', phone: '9990004444' }))
        .toMatchObject({ ok: false, reason: 'no_account' });
    });
  });

  describe('the sign-in FLEET and whose turn it is', () => {
    const fleet = async (n) => {
      for (let i = 1; i <= n; i++) {
        await addBot(bot({
          botId: `f${i}`, label: `signin ${i}`, username: `@bb_${i}`, status: 'ACTIVE',
        }));
        // The rotation orders by added_at, and a test that inserts n bots in
        // one millisecond has no order at all — the tie-break is bot_id, which
        // would make this pass for the wrong reason. Space them.
        await pgQuery(`UPDATE telegram_bots SET added_at = now() + ($1 || ' seconds')::interval
                        WHERE bot_id = $2`, [i, `f${i}`]);
      }
    };
    const players = async (n) => {
      for (let i = 1; i <= n; i++) {
        await createUser({ userId: `p${i}`, username: `p${i}`, mobile: `99900000${String(i).padStart(2, '0')}` });
      }
    };

    it('allows ANY number of live sign-in bots', async () => {
      // The whole reason the generated `live_slot` stopped naming this role.
      // One bot is a throughput ceiling (~30 messages a second), not a design.
      await fleet(5);
      expect(await listBots({ role: 'signin', status: 'ACTIVE' })).toHaveLength(5);
    });

    it('assigns them in a CYCLE, and starts again at the first', async () => {
      await fleet(3);
      await players(7);
      const got = [];
      for (let i = 1; i <= 7; i++) got.push(await assignSigninBot(`p${i}`, 'PLAYER'));
      // The owner's words: "assign 1, assign 2, then 3rd ... and once it
      // reaches all, again start from 1."
      const first = got[0];
      const order = ['f1', 'f2', 'f3'];
      const start = order.indexOf(first);
      expect(start).toBeGreaterThan(-1);
      expect(got).toEqual(Array.from({ length: 7 }, (_, i) => order[(start + i) % 3]));
    });

    it('KEEPS an assignment once made, so the player is not sent to a new chat', async () => {
      await fleet(3);
      await players(1);
      const mine = await assignSigninBot('p1', 'PLAYER');
      expect(await assignSigninBot('p1', 'PLAYER')).toBe(mine);
      expect(await assignSigninBot('p1', 'PLAYER')).toBe(mine);
    });

    it('MOVES a player whose bot was retired, with no sweep and no migration', async () => {
      await fleet(3);
      await players(6);
      for (let i = 1; i <= 6; i++) await assignSigninBot(`p${i}`, 'PLAYER');
      const orphaned = (await pgQuery(
        `SELECT user_id FROM users WHERE telegram_bot_id = 'f2'`)).rows.map((r) => r.user_id);
      expect(orphaned.length).toBeGreaterThan(0);

      expect((await retireBot('f2', { actor: 'admin' })).ok).toBe(true);
      for (const id of orphaned) {
        const now = await assignSigninBot(id, 'PLAYER');
        expect(now).not.toBe('f2');
        expect(['f1', 'f3']).toContain(now);
      }
    });

    it('rotates each panel through its OWN fleet, independently', async () => {
      // Three fleets of different sizes share one sequence, deliberately: the
      // modulo is taken over each audience's own live count. What must NEVER
      // happen is a merchant being handed a player bot — they have no
      // conversation with it, so Telegram refuses the reply and the person sees
      // a chat that simply stopped (§33.2).
      await fleet(3);
      await addBot(bot({ botId: 'm1', audience: 'MERCHANT', username: '@m1', status: 'ACTIVE' }));
      await addBot(bot({ botId: 's1', audience: 'STAFF', username: '@s1', status: 'ACTIVE' }));

      await createUser({ userId: 'pl', username: 'pl', mobile: '9990001111' });
      await createUser({ userId: 'me', username: 'me', mobile: '9990002222', accountType: 'MERCHANT' });
      await createUser({ userId: 'st', username: 'st', mobile: '9990003333', accountType: 'STAFF' });

      expect(['f1', 'f2', 'f3']).toContain(await assignSigninBot('pl', 'PLAYER'));
      expect(await assignSigninBot('me', 'MERCHANT')).toBe('m1');
      expect(await assignSigninBot('st', 'STAFF')).toBe('s1');
    });

    it('answers null for a panel with no fleet, while another panel has one', async () => {
      // The state a fresh install sits in for every panel but the one the
      // operator set up first. It is a REAL state, not an error — the caller
      // reports it rather than blaming the person — and a fleet existing
      // somewhere else must not make it look configured.
      await fleet(2);
      await createUser({ userId: 'me', username: 'me', mobile: '9990002222', accountType: 'MERCHANT' });
      expect(await assignSigninBot('me', 'MERCHANT')).toBeNull();
    });

    it('counts the last-live-bot refusal WITHIN a panel', async () => {
      // The guard counts what would be left. Unscoped it counted the player
      // fleet's spares as reasons the merchant panel would survive — so
      // retiring the only merchant bot would have been allowed, and the first
      // merchant to verify would have met a gate with no bot to open.
      await fleet(3);
      await addBot(bot({ botId: 'm1', audience: 'MERCHANT', username: '@m1', status: 'ACTIVE' }));
      expect(await retireBot('m1', { actor: 'a' }))
        .toMatchObject({ ok: false, reason: 'IS_LIVE', audience: 'MERCHANT' });
    });

    it('refuses to retire the LAST live sign-in bot', async () => {
      await fleet(2);
      expect((await retireBot('f1', { actor: 'a' })).ok).toBe(true);
      // Retiring this one would leave nobody able to verify a number. The
      // guard is in the statement, not in a read the caller does first.
      expect(await retireBot('f2', { actor: 'a' })).toMatchObject({ ok: false, reason: 'IS_LIVE' });
    });

    it('answers null when the operator has registered no bot yet', async () => {
      // A real state at launch, and one the caller REPORTS rather than
      // treating as an error — the account exists, it simply cannot be
      // verified yet.
      await players(1);
      expect(await assignSigninBot('p1', 'PLAYER')).toBeNull();
    });

    it('reports the load each live bot carries, including one carrying nobody', async () => {
      await fleet(3);
      await players(2);
      await assignSigninBot('p1', 'PLAYER');
      await assignSigninBot('p2', 'PLAYER');
      const loads = await signinBotLoads({ audience: 'PLAYER' });
      expect(loads).toHaveLength(3);
      // count(*) is BIGINT and node-postgres returns BIGINT as a STRING
      // (trap 5). Uncast, every comparison an operator's screen makes on this
      // figure is wrong.
      for (const row of loads) expect(typeof row.assigned).toBe('number');
      expect(loads.reduce((n, r) => n + r.assigned, 0)).toBe(2);
    });
  });

  describe('linking a Telegram account to an account that ALREADY EXISTS', () => {
    beforeEach(async () => {
      await createUser({ userId: 'u-1', username: 'a', mobile: '9990000001' });
    });

    it('matches the shared contact against users.mobile', async () => {
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' }))
        .toMatchObject({ ok: true, userId: 'u-1', relinked: false });
      expect((await getIdentityByTelegramId('t-1', 'PLAYER')).userId).toBe('u-1');
    });

    it('CREATES NOTHING when the number matches no account', async () => {
      // The difference from what this replaced, stated as a test. A contact
      // that matches nothing is somebody who has not filled the form yet.
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-9', phone: '9999999999' }))
        .toMatchObject({ ok: false, reason: 'no_account' });
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM users');
      expect(rows[0].n).toBe(1);
    });

    it('is idempotent for a re-share from the same Telegram account', async () => {
      await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' });
      // People tap the button twice, and a bot swap sends them back through it.
      // Refusing reads to the person as though verification had failed.
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' }))
        .toMatchObject({ ok: true, relinked: true });
    });

    it('refuses a SECOND Telegram account for one platform account', async () => {
      await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' });
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-2', phone: '9990000001' }))
        .toMatchObject({ ok: false });
    });

    it('refuses to point one Telegram account at a second platform account', async () => {
      await createUser({ userId: 'u-2', username: 'b', mobile: '9990000002' });
      await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' });
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000002' }))
        .toMatchObject({ ok: false, reason: 'already_linked' });
    });

    it('ignores a DELETED account, so its number cannot be re-verified', async () => {
      // `users_deleted_has_actor` requires the actor and the timestamp: a
      // deletion nobody can attribute is a row the schema refuses, which is
      // why this is not a one-column UPDATE.
      await pgQuery(`UPDATE users SET status = 'DELETED', deleted_at = now(),
                                      deleted_by = 'admin-1' WHERE user_id = 'u-1'`);
      expect(await linkTelegramToAccount({ audience: 'PLAYER', telegramUserId: 't-1', phone: '9990000001' }))
        .toMatchObject({ ok: false, reason: 'no_account' });
    });
  });


  describe('the sweep reclaims space and decides nothing', () => {
    it('removes only expired rows, and counts what it actually deleted', async () => {
      // Drain first. These counts are EXACT, and `sweepExpired` deletes across
      // the whole table — so without this the assertion is a global invariant
      // over a shared database, which trap §20.10 says never to write. It found
      // its own instance: a session another file left live with a 600-second
      // TTL is expired by the next run, and the count came back 16.
      await sweepExpired();

      // TWO tables now. Three others (pending links, login tokens, login codes)
      // were swept here until 2026-09-23 and no longer exist — and the shape
      // assertion below is exactly what made that safe to do: a sweep still
      // naming a dropped table throws 42P01 on every pass and takes the whole
      // retention job down, and this test is what says so before deploy.
      await putRecoverySession({ audience: 'PLAYER', telegramUserId: 't-rec-live', aadhaarHashes: ['h'], ttlSeconds: 600 });
      await putRecoverySession({ audience: 'PLAYER', telegramUserId: 't-rec-dead', aadhaarHashes: ['h'], ttlSeconds: 600 });
      await pgQuery(`UPDATE telegram_recovery_sessions SET expires_at = now() - interval '1 s'
                      WHERE telegram_user_id = 't-rec-dead'`);

      // Exact SHAPE, not just the count — and it earned that this run: adding
      // `password_resets` to the sweep changed the object, and this assertion
      // is what said so. A new expiring table reclaimed silently would make
      // "how much did we delete" quietly stop describing the sweep.
      expect(await sweepExpired()).toEqual({ recoverySessions: 1, passwordResets: 0 });
      expect(await getRecoverySession('t-rec-live', 'PLAYER')).not.toBeNull();
      // Reconstructed per pass: a second pass finds nothing, rather than
      // reporting a total it accumulated (trap 6).
      expect(await sweepExpired()).toEqual({ recoverySessions: 0, passwordResets: 0 });

      // The live row this test made is removed rather than left to expire: see
      // the drain above for why a leftover here comes back as somebody else's
      // failure ten minutes later.
      await pgQuery("DELETE FROM telegram_recovery_sessions WHERE telegram_user_id = 't-rec-live'");
    });
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Signup: a FORM, and nothing else.
//
// `createAccountFromOnboarding` is gone with the conversation that fed it. The
// account is written by `createAccountFromSignup`, which takes what a person
// typed — Aadhaar, the Aadhaar-linked mobile, a password — and writes the
// account and the queued Aadhaar in ONE transaction. No Telegram identity is
// created here, by design: the contact share proves the number AFTERWARDS, and
// an identity written at signup would be an unproven one that the gate would
// then have to distinguish from a proven one.
// ─────────────────────────────────────────────────────────────────────────────
import { createAccountFromSignup } from '../repositories/identity.js';
import { getUser, newUserId } from '../repositories/users.js';
import { getVerification, isAadhaarRegistered } from '../repositories/identity.js';

const signup = (over = {}) => ({
  userId: newUserId(), mobile: '9990001111', username: 'newplayer',
  passwordHash: '$argon2id$fake', referralCode: 'MYCODE01',
  aadhaarHash: 'ah-1', aadhaarEncrypted: 'ac-1', aadhaarLast4: '4321', ...over,
});

describePg('signup (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE kyc_verifications, telegram_identities, users
                   RESTART IDENTITY CASCADE`);
  });

  it('writes the account and the queued Aadhaar together', async () => {
    const r = await createAccountFromSignup(signup());
    expect(r.ok).toBe(true);

    const user = await getUser(r.userId);
    expect(user).toMatchObject({
      mobile: '9990001111', status: 'ACTIVE', kycStatus: 'PENDING_APPROVAL',
      // The signup IS submission one. Counted in the same INSERT, so the
      // reapply cap cannot silently allow one more attempt than it advertises.
      kycSubmissionCount: 1,
    });
    expect((await getVerification(r.userId)).status).toBe('PENDING_VERIFICATION');
  });

  it('creates NO Telegram identity — that is the next step, and it is separate', async () => {
    const r = await createAccountFromSignup(signup());
    expect(await getIdentityByUserId(r.userId, { activeOnly: false })).toBeNull();
    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_identities');
    expect(rows[0].n).toBe(0);
  });

  it('claims NO joining number, so an unverified signup cannot jump the queue', async () => {
    // The number orders the referral payout queue and is claimed when the
    // Telegram step COMPLETES. Allocating it here would let a form submitted in
    // a loop consume positions ahead of people who actually verified — and pay
    // somebody 25 rupees for each one.
    const r = await createAccountFromSignup(signup());
    expect((await getUser(r.userId)).joiningNumber).toBeFalsy();
  });

  it('sets a password hash, because the form is now the door', async () => {
    const r = await createAccountFromSignup(signup());
    const { rows } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [r.userId]);
    expect(rows[0].password_hash).toBe('$argon2id$fake');
  });

  it('refuses to write an account with no password at all', async () => {
    // A row with a NULL hash would be an account nobody can sign into and
    // nothing would ever say so. Refused at the boundary rather than written.
    await expect(createAccountFromSignup(signup({ passwordHash: null })))
      .rejects.toThrow(/passwordHash/);
  });

  it('leaves NOTHING behind when the Aadhaar is already registered', async () => {
    await createAccountFromSignup(signup());
    const second = await createAccountFromSignup(signup({
      userId: newUserId(), mobile: '9990002222', referralCode: 'MYCODE02',
    }));
    expect(second).toEqual({ ok: false, reason: 'aadhaar_taken' });

    // The account insert comes FIRST in the transaction, so a partial signup
    // here would leave an account nobody can verify and an Aadhaar that can
    // never be registered again.
    const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM users`);
    expect(rows[0].n).toBe(1);
  });

  it('reports the mobile and the Aadhaar as DIFFERENT refusals', async () => {
    // They send the person to different places — "log in instead" versus "each
    // Aadhaar can hold one account" — so the constraint name is read rather
    // than every collision being collapsed into one message.
    await createAccountFromSignup(signup());
    expect(await createAccountFromSignup(signup({
      userId: newUserId(), aadhaarHash: 'ah-2', aadhaarEncrypted: 'ac-2', referralCode: 'MYCODE03',
    }))).toEqual({ ok: false, reason: 'mobile_taken' });
    expect(await isAadhaarRegistered('ah-2')).toBe(false);
  });

  it('10 concurrent submissions of one form produce ONE account', async () => {
    // Somebody double-tapping Sign Up on a slow connection. The unique indexes
    // decide, not a read the route did first.
    const attempts = Array.from({ length: 10 }, () =>
      createAccountFromSignup(signup({ userId: newUserId(), referralCode: null })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM kyc_verifications`)).rows[0].n).toBe(1);
  });

  it('carries the referral attribution the form captured', async () => {
    const first = await createAccountFromSignup(signup());
    const second = await createAccountFromSignup(signup({
      userId: newUserId(), mobile: '9990002222', aadhaarHash: 'ah-2',
      aadhaarEncrypted: 'ac-2', referralCode: 'MYCODE02', referredBy: first.userId,
    }));
    expect((await getUser(second.userId)).referredBy).toBe(first.userId);
  });

  it('gives each account an unpredictable id, not one derived from the phone', async () => {
    // Account ids travel in URLs and payloads. An id computable from a phone
    // number would let anyone holding the number address the account.
    const r = await createAccountFromSignup(signup());
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
    await createIdentity({ audience: 'PLAYER', telegramUserId: 't-old', userId: 'u-1', phone: '9990000001' });

    const result = await relinkIdentity({ audience: 'PLAYER',
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
    const old = await getIdentityByTelegramId('t-old', 'PLAYER');
    expect(old.contactActive).toBe(false);
    expect(old.channelStatus).toBe('left');
    expect(old.userId).toBe('u-1');
    expect((await listIdentitiesForUser('u-1')).map((i) => i.telegramUserId).sort())
      .toEqual(['t-new', 't-old']);
  });

  it('frees the phone slot, so the new identity can claim the same number', async () => {
    await createIdentity({ audience: 'PLAYER', telegramUserId: 't-old', userId: 'u-1', phone: '9990000001' });
    // `one_active_identity_per_phone` is partial on contact_active. Two steps
    // would either be refused outright or leave the account with no active
    // identity between them.
    const result = await relinkIdentity({ audience: 'PLAYER',
      telegramUserId: 't-new', userId: 'u-1', phone: '9990000001',
    });
    expect(result.ok).toBe(true);
    expect(result.identity.contactActive).toBe(true);
  });

  it('refuses to hand a second account to one Telegram identity', async () => {
    await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
    await createIdentity({ audience: 'PLAYER', telegramUserId: 't-2', userId: 'u-2', phone: '9990000002' });

    // t-2 already holds u-2. Giving it u-1 as well would create exactly the
    // duplicate the design exists to prevent — and it is a REFUSAL rather than
    // a thrown duplicate-key error, so the caller answers with a message.
    const result = await relinkIdentity({ audience: 'PLAYER',
      telegramUserId: 't-2', userId: 'u-1', phone: '9990000001',
    });
    expect(result).toEqual({ ok: false, reason: 'TELEGRAM_ALREADY_LINKED' });

    // Nothing moved.
    expect(await getIdentityByUserId('u-1')).toMatchObject({ telegramUserId: 't-1' });
    expect(await getIdentityByUserId('u-2')).toMatchObject({ telegramUserId: 't-2' });
  });

  it('is idempotent when the same identity asks twice', async () => {
    await createIdentity({ audience: 'PLAYER', telegramUserId: 't-1', userId: 'u-1', phone: '9990000001' });
    const again = await relinkIdentity({ audience: 'PLAYER',
      telegramUserId: 't-1', userId: 'u-1', phone: '9990000001',
    });
    // The same Telegram account re-points its own row rather than colliding
    // with itself, and displaces nobody.
    expect(again.ok).toBe(true);
    expect(again.displacedTelegramUserId).toBeNull();
    expect(await getIdentityByUserId('u-1')).toMatchObject({ telegramUserId: 't-1' });
  });

  it('links a first identity when the account has none', async () => {
    const first = await relinkIdentity({ audience: 'PLAYER',
      telegramUserId: 't-fresh', userId: 'u-9', phone: '9990000009',
    });
    expect(first.ok).toBe(true);
    // A recovery that displaced nobody is a first link, not a recovery — and
    // the caller can tell the two apart.
    expect(first.displacedTelegramUserId).toBeNull();
  });
});

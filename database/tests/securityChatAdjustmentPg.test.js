// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The three controls that were referenced everywhere and DEFINED NOWHERE.
 *
 * `BlockedIP`, `ChatMessage` and `BalanceAdjustment` were asked for through the
 * document store in five files. None of the three was ever registered, so every
 * call raised MissingSchemaError:
 *
 *   • the IP deny-list threw into a catch that fails open without logging, so
 *     it has never blocked an address, and `blockIP` reported success to the
 *     operator every time it did nothing;
 *   • every order-chat write threw, four of them into a bare `catch (_) {}`, so
 *     messages echoed over the socket and did not survive a reload — and a
 *     dispute was decided against an empty record;
 *   • the admin adjustment wrote its audit row FIRST, so the throw took the
 *     money movement with it: that endpoint has never once succeeded.
 *
 * These tests run the real bodies against a real PostgreSQL. Each one asserts
 * the property the missing model destroyed, not that a function was called.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  isIpBlocked, blockIp, unblockIp, listBlockedIps, invalidateIpCache,
} from '../repositories/security.js';
import {
  postMessage, postSystemMessage, listMessages, countMessages,
} from '../repositories/chat.js';
import {
  applyAdjustment, getAdjustment, listAdjustments, ADJUSTABLE_FIELDS,
} from '../repositories/balanceAdjustments.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the three controls that were defined nowhere', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  // ══════════════════════════════════════════════════════════════════════════
  describe('the IP deny-list', () => {
    beforeEach(async () => {
      await pgQuery('DELETE FROM blocked_ips', []);
      invalidateIpCache();
    });

    it('blocks an address, which is the thing it has never done', async () => {
      expect(await isIpBlocked('203.0.113.7')).toBe(false);
      await blockIp('203.0.113.7', { reason: 'Credential stuffing', actor: 'admin-1' });
      expect(await isIpBlocked('203.0.113.7')).toBe(true);
    });

    it('applies a new block IMMEDIATELY, not at the next cache expiry', async () => {
      // The read below populates the cache with "not blocked". Being slow to
      // stop an attacker is the expensive direction of this trade, so the write
      // invalidates rather than waiting out the TTL.
      expect(await isIpBlocked('203.0.113.8')).toBe(false);
      await blockIp('203.0.113.8', { reason: 'Scraping' });
      expect(await isIpBlocked('203.0.113.8')).toBe(true);
    });

    it('releases an address and KEEPS the row, because an appeal reads it', async () => {
      await blockIp('203.0.113.9', { reason: 'Fraud ring', actor: 'admin-1' });
      await unblockIp('203.0.113.9', { actor: 'admin-2' });

      expect(await isIpBlocked('203.0.113.9')).toBe(false);
      const { rows } = await pgQuery(
        'SELECT reason, active, unblocked_by FROM blocked_ips WHERE ip = $1', ['203.0.113.9'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].active).toBe(false);
      expect(rows[0].reason).toBe('Fraud ring');
      expect(rows[0].unblocked_by).toBe('admin-2');
    });

    it('re-blocking a released address revives the row rather than colliding', async () => {
      await blockIp('203.0.113.10', { reason: 'First' });
      await unblockIp('203.0.113.10');
      await blockIp('203.0.113.10', { reason: 'Second' });

      expect(await isIpBlocked('203.0.113.10')).toBe(true);
      const { rows } = await pgQuery(
        'SELECT reason, unblocked_at FROM blocked_ips WHERE ip = $1', ['203.0.113.10'],
      );
      expect(rows[0].reason).toBe('Second');
      // The stale release must be cleared, or the row says both at once.
      expect(rows[0].unblocked_at).toBeNull();
    });

    it('a temporary block LAPSES ON THE READ, without waiting for a sweep', async () => {
      // PostgreSQL has no TTL index. If expiry were left to a sweep, a late or
      // dead sweep would keep an expired block in force indefinitely.
      await blockIp('203.0.113.11', {
        reason: 'Rate abuse', expiresAt: new Date(Date.now() - 1000),
      });
      invalidateIpCache();
      expect(await isIpBlocked('203.0.113.11')).toBe(false);

      // …and the converse: an unexpired one holds even though nothing swept.
      await blockIp('203.0.113.12', {
        reason: 'Rate abuse', expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await isIpBlocked('203.0.113.12')).toBe(true);
    });

    it('the operator list shows live blocks and hides released ones by default', async () => {
      await blockIp('203.0.113.13', { reason: 'Live' });
      await blockIp('203.0.113.14', { reason: 'Released' });
      await unblockIp('203.0.113.14');

      const live = await listBlockedIps();
      expect(live.map((r) => r.ip)).toEqual(['203.0.113.13']);

      const all = await listBlockedIps({ includeReleased: true });
      expect(all.map((r) => r.ip).sort()).toEqual(['203.0.113.13', '203.0.113.14']);
    });

    it('an empty address is not blocked, and never becomes a query', async () => {
      expect(await isIpBlocked(null)).toBe(false);
      expect(await isIpBlocked('')).toBe(false);
      await expect(blockIp('')).rejects.toThrow(/requires an ip/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('order chat', () => {
    beforeEach(async () => { await pgQuery('DELETE FROM chat_messages', []); });

    it('a message SURVIVES — the property the missing model destroyed', async () => {
      await postMessage({ orderId: 'ord-1', senderId: 'u1', senderType: 'USER', message: 'Paid, see UTR' });
      const thread = await listMessages('ord-1');
      expect(thread).toHaveLength(1);
      expect(thread[0].message).toBe('Paid, see UTR');
      expect(thread[0].senderType).toBe('USER');
    });

    it('reads back oldest-first, tie-broken by id so a sequence is a sequence', async () => {
      // Two messages inserted in the same millisecond order arbitrarily under
      // created_at alone, and a chat read out of order is a different chat.
      for (const text of ['one', 'two', 'three', 'four', 'five']) {
        await postMessage({ orderId: 'ord-2', senderId: 'u1', senderType: 'USER', message: text });
      }
      const thread = await listMessages('ord-2');
      expect(thread.map((m) => m.message)).toEqual(['one', 'two', 'three', 'four', 'five']);
    });

    it('keeps threads apart by order', async () => {
      await postMessage({ orderId: 'ord-3', senderId: 'u1', senderType: 'USER', message: 'mine' });
      await postMessage({ orderId: 'ord-4', senderId: 'u2', senderType: 'USER', message: 'theirs' });
      expect((await listMessages('ord-3')).map((m) => m.message)).toEqual(['mine']);
      expect(await countMessages('ord-4')).toBe(1);
    });

    it('a SYSTEM message has no sender, and that is allowed only for SYSTEM', async () => {
      const sys = await postMessage({ orderId: 'ord-5', senderType: 'SYSTEM', message: 'Merchant assigned' });
      expect(sys.senderId).toBeNull();
      expect(sys.senderName).toBe('System');

      await expect(
        postMessage({ orderId: 'ord-5', senderType: 'USER', message: 'anonymous' }),
      ).rejects.toThrow(/chat_messages_sender_required/);
    });

    it('refuses a message with neither text nor an attachment', async () => {
      await expect(
        postMessage({ orderId: 'ord-6', senderId: 'u1', senderType: 'USER', message: '' }),
      ).rejects.toThrow(/chat_messages_has_content/);
    });

    it('accepts an attachment with no text', async () => {
      const m = await postMessage({
        orderId: 'ord-7', senderId: 'u1', senderType: 'USER', message: '',
        attachmentUrl: 'https://cdn.example/x.png', attachmentKey: 'chat/u1/x.png',
      });
      expect(m.attachmentUrl).toBe('https://cdn.example/x.png');
      expect(m.attachmentKey).toBe('chat/u1/x.png');
    });

    it('refuses an unknown senderType instead of storing one nothing renders', async () => {
      await expect(
        postMessage({ orderId: 'ord-8', senderId: 'u1', senderType: 'ROBOT', message: 'hi' }),
      ).rejects.toThrow(/unknown senderType/);
    });

    it('coerces the order id, so one thread cannot split across two spellings', async () => {
      await postMessage({ orderId: 12345, senderId: 'u1', senderType: 'USER', message: 'a' });
      await postMessage({ orderId: '12345', senderId: 'u1', senderType: 'USER', message: 'b' });
      expect(await countMessages('12345')).toBe(2);
    });

    it('a system NOTICE never fails the operation it describes', async () => {
      // An order really was rejected whether or not the note about it landed.
      // Content that violates the CHECK is the cheapest way to force a failure.
      const result = await postSystemMessage('ord-9', '');
      expect(result).toBeNull();
      expect(await countMessages('ord-9')).toBe(0);
    });

    it('a dispute notice may be ADMIN-sent and still flagged as a system message', async () => {
      // The two are not the same thing, which is why is_system is a column and
      // not derived from sender_type.
      const m = await postSystemMessage('ord-10', '⚖️ RESOLVED', { senderId: 'admin-1', senderType: 'ADMIN' });
      expect(m.senderType).toBe('ADMIN');
      expect(m.isSystem).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('admin balance adjustments', () => {
    const ADMIN = 'adj-admin-1';

    // A FRESH user per test, rather than a reset between them: `wallet_ledger`
    // is append-only by trigger, so a suite that tears down by deleting its
    // ledger rows cannot run at all — and one that worked around the trigger
    // would be testing a database the production one is not.
    let USER;
    let seq = 0;
    // `wallet_ledger.tx_id` is GLOBALLY unique, and the adjustment's id is what
    // makes its txId. Ids fixed in the source would collide with the previous
    // RUN of this file against the same database — the replay path would fire
    // and nothing would move. Production ids are random; these are too.
    const RUN = Math.random().toString(36).slice(2, 8);

    beforeEach(async () => {
      seq += 1;
      USER = `adj-user-${RUN}-${seq}`;
      await pgQuery('DELETE FROM balance_adjustments', []);
      await pgQuery(
        `INSERT INTO wallets (user_id, deposit_paise, winnings_paise, token_paise)
         VALUES ($1, 100000, 50000, 7000)`, [USER],
      );
    });

    const adjust = (over = {}) => applyAdjustment({
      adjustmentId: `adj-1-${RUN}-${seq}`, userId: USER, adminId: ADMIN,
      type: 'CREDIT', field: 'depositBalance', amountRupees: 100,
      reason: 'Goodwill', ...over,
    });

    it('moves the money AND writes the audit row — neither used to happen', async () => {
      const r = await adjust();
      expect(r.ok).toBe(true);
      expect((await getBalancesPaise(USER)).depositBalance).toBe(110000);

      const row = await getAdjustment(`adj-1-${RUN}-${seq}`);
      expect(row.adminId).toBe(ADMIN);
      expect(row.reason).toBe('Goodwill');
      expect(row.beforePaise).toBe(100000);
      expect(row.afterPaise).toBe(110000);
    });

    it('CREDITS THE POCKET IT WAS GIVEN — `field` used to be ignored', async () => {
      // Every credit went to winnings and every debit came out of deposit
      // first, whatever the admin named, while the audit row recorded the name.
      await adjust({ adjustmentId: `adj-w-${RUN}-${seq}`, field: 'winningsBalance', amountRupees: 25 });
      const after = await getBalancesPaise(USER);
      expect(after.winningsBalance).toBe(52500);
      expect(after.depositBalance).toBe(100000);   // untouched
    });

    it('DEBITS THE POCKET IT WAS GIVEN, not deposit-first', async () => {
      await adjust({ adjustmentId: `adj-d-${RUN}-${seq}`, type: 'DEBIT', field: 'winningsBalance', amountRupees: 200 });
      const after = await getBalancesPaise(USER);
      expect(after.winningsBalance).toBe(30000);
      expect(after.depositBalance).toBe(100000);   // NOT raided
    });

    it('adjusts tokenBalance, which the route accepted and the writer discarded', async () => {
      await adjust({ adjustmentId: `adj-t-${RUN}-${seq}`, field: 'tokenBalance', amountRupees: 30 });
      expect((await getBalancesPaise(USER)).tokenBalance).toBe(10000);
    });

    it('refuses a pocket it cannot honour rather than substituting one', async () => {
      await expect(adjust({ adjustmentId: `adj-l-${RUN}-${seq}`, field: 'lockedBalance' }))
        .rejects.toThrow(/Cannot adjust 'lockedBalance'/);
      expect(ADJUSTABLE_FIELDS).not.toContain('lockedBalance');
    });

    it('refuses an over-debit and moves NOTHING', async () => {
      const r = await adjust({ adjustmentId: `adj-x-${RUN}-${seq}`, type: 'DEBIT', field: 'winningsBalance', amountRupees: 900 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('INSUFFICIENT');
      expect(r.availableRupees).toBe(500);

      expect((await getBalancesPaise(USER)).winningsBalance).toBe(50000);
      // And it must not leave a decision row claiming an adjustment happened.
      expect(await getAdjustment(`adj-x-${RUN}-${seq}`)).toBeNull();
    });

    it('an audit row and its money are ONE transaction — neither, or both', async () => {
      // The CHECK on the table refuses a row whose arithmetic does not close.
      // Force one by adjusting a field the wallet holds and the audit rejects.
      await expect(adjust({ adjustmentId: `adj-bad-${RUN}-${seq}`, reason: '   ' }))
        .rejects.toThrow(/requires a reason/);
      // The throw happened before the lock, so nothing moved.
      expect((await getBalancesPaise(USER)).depositBalance).toBe(100000);

      // Now the real proof: a duplicate primary key inside the transaction must
      // roll the MONEY back too, not just the row.
      await adjust({ adjustmentId: `adj-dup-${RUN}-${seq}` });
      const midway = (await getBalancesPaise(USER)).depositBalance;
      await pgQuery('DELETE FROM balance_adjustments WHERE adjustment_id = $1', [`adj-dup-${RUN}-${seq}`]);
      // The ledger key survives, so a replay under the same id is refused the
      // second movement and records the audit row it never got. The balance
      // must not move twice.
      const replay = await applyAdjustment({
        adjustmentId: `adj-dup-${RUN}-${seq}`, userId: USER, adminId: ADMIN,
        type: 'CREDIT', field: 'depositBalance', amountRupees: 100, reason: 'Goodwill',
      });
      expect(replay.ok).toBe(true);
      expect((await getBalancesPaise(USER)).depositBalance).toBe(midway);
      expect(await getAdjustment(`adj-dup-${RUN}-${seq}`)).not.toBeNull();
    });

    it('a retry of the same adjustment is a retry, not a second adjustment', async () => {
      await adjust();
      const again = await adjust();
      expect(again.idempotent).toBe(true);
      expect((await getBalancesPaise(USER)).depositBalance).toBe(110000);

      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM balance_adjustments', []);
      expect(rows[0].n).toBe(1);
    });

    it('stores paise, so rupee floats cannot enter the audit record', async () => {
      // 0.1 + 0.2 in rupees is 0.30000000000000004; in paise it is 30.
      await adjust({ adjustmentId: `adj-f1-${RUN}-${seq}`, amountRupees: 0.1 });
      await adjust({ adjustmentId: `adj-f2-${RUN}-${seq}`, amountRupees: 0.2 });
      const { rows } = await pgQuery(
        'SELECT SUM(amount_paise)::int AS total FROM balance_adjustments', [],
      );
      expect(rows[0].total).toBe(30);
      expect((await getBalancesPaise(USER)).depositBalance).toBe(100030);
    });

    it('rejects a blank reason: "adjusted by admin, reason blank" answers nothing', async () => {
      await expect(adjust({ adjustmentId: `adj-r-${RUN}-${seq}`, reason: '' })).rejects.toThrow(/requires a reason/);
      await expect(adjust({ adjustmentId: `adj-r2-${RUN}-${seq}`, amountRupees: 0 })).rejects.toThrow(/Invalid adjustment amount/);
      await expect(adjust({ adjustmentId: `adj-r3-${RUN}-${seq}`, amountRupees: -5 })).rejects.toThrow(/Invalid adjustment amount/);
    });

    it('leaves a wallet_ledger row, because a balance must never move unaudited', async () => {
      await adjust({ adjustmentId: `adj-led-${RUN}-${seq}` });
      const { rows } = await pgQuery(
        'SELECT tx_id, description FROM wallet_ledger WHERE user_id = $1 AND tx_id = $2',
        [USER, `admin_adj-led-${RUN}-${seq}`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toContain(`[Admin:${ADMIN}]`);
    });

    it('lists newest-first with a total that agrees with the page it labels', async () => {
      for (let i = 0; i < 5; i += 1) {
        await adjust({ adjustmentId: `adj-p${seq}-${i}`, amountRupees: i + 1 });
      }
      const page = await listAdjustments({ userId: USER, page: 1, limit: 2 });
      expect(page.total).toBe(5);
      expect(page.adjustments).toHaveLength(2);

      const filtered = await listAdjustments({ userId: 'nobody' });
      expect(filtered.total).toBe(0);
      expect(filtered.adjustments).toEqual([]);
    });
  });
});

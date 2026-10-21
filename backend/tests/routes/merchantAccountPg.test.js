// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Merchant accounts (owner, 2026-10-11 — Phase B of the merchants-and-agents
 * plan), through the real routes and a real database.
 *
 * A merchant account is a DIRECT team owned by one merchant, serving INR
 * orders itself through its own payment accounts and its own sub-members. What
 * is pinned here:
 *
 *   · the admin's per-size lists send INR sizes to merchant accounts; the
 *     orders still WAITING move to the new mode (re-railed), the ones already
 *     assigned finish where they are, and USDT never moves;
 *   · a buy paid by UPI QR (a link built with the order's amount) and one paid
 *     into a BANK account, each end to end: assigned with the pool HELD,
 *     started, paid, confirmed — the pool, TEAM_FLOAT → USER_FLOAT and the
 *     player's pocket asserted;
 *   · a sell is marked paid only FROM one of the account's own withdrawal
 *     accounts, named in the Paid transition;
 *   · sub-member roles: DEPOSITS / WITHDRAWALS / AUDIT, owner-only writes, and
 *     a change of roles ends the old sessions;
 *   · problems flag at the admin's daily threshold and never suspend, while an
 *     AGENT's refusals still suspend;
 *   · the commission percent is the admin's, all of it the owner's share;
 *   · a UPI ID or payee name that is a mobile is refused, by the parser and by
 *     the row.
 *
 * Trap 10: every config this suite writes is restored in afterAll; its rows
 * (orders, accounts, staff, teams, ledger postings) are removed or reversed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { recordEvent } from '#db/repositories/ledger.core.js';
import { getUtr } from '#db/repositories/utr.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { toPlayerOrderView } from '../../domains/payment/playerOrderView.js';
import { systemConfigPayload } from '../../domains/configuration/systemConfigPayload.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';
import { ORDER_SIZES } from '../../domains/merchant/denominations.js';

// Every size of both directions to merchant accounts, or every size to agents.
const TO_MERCHANTS = { merchantBuySizes: [...ORDER_SIZES], merchantSellSizes: [...ORDER_SIZES] };
const TO_AGENTS = { merchantBuySizes: [], merchantSellSizes: [] };

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const POOL = 'MERCHANT_BONUS_POOL';

/** Raw (signed) balance of a ledger account. */
async function raw(account) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS v
       FROM accounting_events, jsonb_array_elements(postings) p WHERE p->>'account' = $1`, [account]);
  return Number(rows[0].v);
}
const bonusPoolPaise = async () => 0 - (await raw(POOL));
const float = async (name) => (await getTreasuryBalances())[ACCOUNTS[name]] ?? 0;

describePg('merchant accounts', () => {
  let panel; let accountApp; let adminApp; let systemApp;
  let admin; let settingsAdmin;
  let seq = 0;
  const teams = teamFixture();
  const players = [];
  const owners = [];
  const directTeams = [];
  const staffUsers = [];
  const posted = [];
  let prior;

  const oid = () => `mac-${RUN}-${seq += 1}`;
  const utr = () => String(610000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));
  const mobile = () => `9${String(Date.now()).slice(-6)}${String((seq += 1) % 1000).padStart(3, '0')}`;
  const config = (patch) => applySystemConfig(patch, { actor: 'merchant-account-suite' });

  beforeAll(async () => {
    await applySchema();
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    accountApp = mountRouter((await import('../../domains/merchant/merchantAccount.routes.js')).default);
    adminApp = mountRouter((await import('../../domains/merchant/merchantAccount.admin.routes.js')).default);
    systemApp = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    settingsAdmin = await actor({ isSubAdmin: true, permissions: { canManageSystemSettings: true } });
    const cfg = await getSystemConfig();
    prior = {
      merchantBuySizes: [...cfg.merchantBuySizes], merchantSellSizes: [...cfg.merchantSellSizes],
      directMerchants: { ...cfg.directMerchants },
    };
  }, 60_000);

  afterAll(async () => {
    await config(prior);
    // The ledger is append-only: everything this suite posted for the
    // commission pool, and the commission paid to its own teams, is reversed.
    const { rows: caused } = await pgQuery(
      `SELECT postings FROM accounting_events WHERE ref_model = 'Team' AND ref_id = ANY($1)`, [directTeams]);
    const net = {};
    for (const p of [...posted, ...caused.flatMap((r) => r.postings)]) {
      net[p.account] = (net[p.account] ?? 0) + Number(p.amountPaise);
    }
    const legs = Object.entries(net).filter(([, v]) => v).map(([account, v]) => ({ account, amountPaise: 0 - v }));
    if (legs.length) {
      await recordEvent({
        eventType: 'ADJUSTMENT', idempotencyKey: `mac-test-undo-${RUN}`, postings: legs,
        refModel: 'Test', refId: 'merchantAccountPg', description: 'merchantAccountPg: reverse what the suite posted',
      });
    }
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      const mine = `SELECT order_id FROM order_states WHERE user_id = ANY($1)`;
      await c.query(`DELETE FROM order_transitions WHERE order_id IN (${mine})`, [players]);
      await c.query(`DELETE FROM dispute_faults WHERE order_id IN (${mine})`, [players]);
      await c.query(`DELETE FROM merchant_problems WHERE merchant_id = ANY($1)`, [owners]);
      await c.query(`DELETE FROM merchant_flags WHERE merchant_id = ANY($1)`, [owners]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
      await c.query('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [directTeams]);
      await c.query(
        'DELETE FROM team_commission_shares WHERE commission_id IN (SELECT commission_id FROM team_commissions WHERE team_id = ANY($1))',
        [directTeams]);
      await c.query('DELETE FROM team_commissions WHERE team_id = ANY($1)', [directTeams]);
      await c.query('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [directTeams]);
      await c.query('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [directTeams]);
      await c.query('DELETE FROM team_pools WHERE team_id = ANY($1)', [directTeams]);
      await c.query(
        'DELETE FROM merchant_staff_accounts WHERE staff_id IN (SELECT staff_id FROM merchant_staff WHERE merchant_id = ANY($1))',
        [owners]);
      await c.query('DELETE FROM merchant_staff WHERE merchant_id = ANY($1)', [owners]);
      await c.query('DELETE FROM users WHERE user_id = ANY($1)', [staffUsers]);
      await c.query('DELETE FROM merchant_payment_accounts WHERE merchant_id = ANY($1)', [owners]);
      await c.query('DELETE FROM teams WHERE team_id = ANY($1)', [directTeams]);
      await c.query('DELETE FROM merchant_online_sessions WHERE merchant_id = ANY($1)', [owners]);
      await c.query('DELETE FROM merchants WHERE merchant_id = ANY($1)', [owners]);
    });
    await teams.cleanup();
    await closePg();
  });

  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  /** Only this merchant account is online among every merchant account. */
  const onlyDirectOnline = async (merchantId) => {
    await pgQuery(
      `UPDATE merchants SET is_online = (merchant_id = $1)
        WHERE merchant_id IN (SELECT owner_merchant_id FROM teams WHERE kind = 'DIRECT')`, [String(merchantId ?? '')]);
  };

  /**
   * A merchant account as an admin makes one (`POST /merchant-accounts`), its
   * pool funded through the owner's request and the admin's fulfilment, with a
   * UPI_QR account taking deposits and a BANK account paying withdrawals.
   */
  const merchantAccount = async ({ poolTokens = 200_000 } = {}) => {
    const owner = await merchantActor();
    owners.push(owner.merchantId);
    const made = await as(adminApp, admin).post('/merchant-accounts').send({ merchantId: owner.merchantId });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const team = (await as(accountApp, owner).get('/account')).body.team;
    expect(team).toMatchObject({ kind: 'DIRECT', ownerMerchantId: String(owner.merchantId) });
    directTeams.push(team.teamId);
    if (poolTokens) await teams.fund({ teamId: team.teamId, supervisorId: owner.merchantId }, poolTokens);
    const n = directTeams.length;
    const upi = await as(accountApp, owner).post('/account/payment-accounts').send({
      kind: 'UPI_QR', label: 'Shop QR',
      upiLink: `upi://pay?pa=shop${RUN}n${n}@okaxis&pn=Shop%20Counter&cu=INR`,
      holderName: 'Shop Counter', accountNo: `7710${RUN.replace(/\D/g, '').padEnd(4, '1')}${n}01`.slice(0, 16),
      ifsc: 'HDFC0001234', bankName: 'HDFC Bank', acceptsDeposits: true, paysWithdrawals: false,
    });
    expect(upi.status, JSON.stringify(upi.body)).toBe(201);
    const bank = await as(accountApp, owner).post('/account/payment-accounts').send({
      kind: 'BANK', label: 'Current account',
      holderName: 'Shop Counter Ltd', accountNo: `8820${n}0045671`, ifsc: 'ICIC0004321', bankName: 'ICICI Bank',
      acceptsDeposits: false, paysWithdrawals: true,
    });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    await onlyDirectOnline(owner.merchantId);
    return { ...owner, team, upi: upi.body.account, bank: bank.body.account };
  };

  /** A sub-member's session, as the merchant door mints it for them. */
  const staffSession = (owner, staff) => {
    const token = signToken({
      merchantId: owner.merchantId, userId: staff.userId, mobile: staff.mobile,
      staffUserId: staff.userId, isMerchant: true, isAdmin: false, amr: ['pwd', 'tg'],
    });
    return { auth: `Bearer ${token}` };
  };

  const addStaff = async (owner, roles) => {
    const res = await as(accountApp, owner).post('/account/staff').send({
      mobile: mobile(), password: 'a-long-staff-password-1', name: `Desk ${seq}`, roles,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    staffUsers.push(res.body.staff.userId);
    return res.body.staff;
  };

  const queuedBuy = async (tokens, who = null) => {
    const p = who ?? await player();
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: p.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, depositAllocation: tokens, reserveAllocation: 0,
    });
    return { order, orderId, player: p };
  };

  const routedSell = async (m, tokens) => {
    const p = await player();
    await updateUser(p.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
    });
    await creditWinnings(p.userId, tokens, 'merchant account suite float', 'Test', `seed_${p.userId}`, `mac_seed_${p.userId}`);
    await onlyDirectOnline(m.merchantId);
    const { order } = await createWithdrawalOrder(p.userId, tokens);
    const orderId = order.orderId ?? order._id;
    const row = await getOrderRecord(orderId);
    expect(row.merchantId, 'the sell was not routed to the merchant account').toBe(String(m.merchantId));
    expect(row.inrRouting).toBe('MERCHANTS');
    return { orderId, player: p };
  };

  // ── The switch ────────────────────────────────────────────────────────────
  describe('the INR routing mode', () => {
    it('moves the waiting INR orders, leaves an assigned one and USDT where they are', async () => {
      await config({ ...TO_AGENTS });
      await onlyDirectOnline(null);
      // An agent order already assigned (a working agent team on the cash rail).
      const agent = await merchantActor();
      await teams.workingTeam({ rail: 'CASH', poolTokens: 20_000, include: [agent.merchantId] });
      const assigned = await queuedBuy(1_000);
      await pgQuery('UPDATE merchants SET cash_ready = TRUE WHERE merchant_id = $1', [agent.merchantId]);
      expect(await tryAssignMerchant(assigned.order)).toBe(true);
      await teams.onlyOnline([]);
      // A cash-sized buy waiting for a first taker: on the CASH rail under agents.
      const waiting = await queuedBuy(1_000);
      expect((await getOrderRecord(waiting.orderId))).toMatchObject({ paymentMode: 'CASH_ATM', inrRouting: 'AGENTS' });
      const usdtPlayer = await player();
      const usdt = await createOrderRecord({
        orderId: oid(), userId: usdtPlayer.userId, type: 'DEPOSIT',
        tokenAmountRupees: 50_000, fiatAmountRupees: 500, currency: 'USDT', usdtChain: 'TRC20', rateUsed: 100,
      });
      expect(usdt.inrRouting ?? null).toBe(null);

      const res = await as(systemApp, settingsAdmin).put('/system/config').send({ ...TO_MERCHANTS });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.rerailedOrders).toBeGreaterThanOrEqual(1);

      // Waiting: moved, and every INR size is UPI or bank under merchant accounts.
      expect(await getOrderRecord(waiting.orderId)).toMatchObject({
        status: 'PENDING_QUEUE', paymentMode: 'P2P_UPI', inrRouting: 'MERCHANTS',
      });
      // Assigned: finishes where it is.
      expect(await getOrderRecord(assigned.orderId)).toMatchObject({
        status: 'PROCESSING', merchantId: String(agent.merchantId), paymentMode: 'CASH_ATM', inrRouting: 'AGENTS',
      });
      // USDT: always the agents', never re-railed.
      const u = await getOrderRecord(usdt.orderId);
      expect(u.inrRouting ?? null).toBe(null);
      expect(u.currency).toBe('USDT');

      // Every client is told: every size under the merchant group, no agent sizes.
      const payload = systemConfigPayload(await getSystemConfig());
      expect(payload.orderSizes.buy.CASH).toEqual([]);
      expect(payload.orderSizes.buy.UPI_BANK).toEqual([]);
      expect(payload.orderSizes.buy.MERCHANT).toContain(1_000);
      expect(payload.orderSizeMethods.buy.MERCHANT).toBe('UPI or bank transfer');
    });

    it('routes each size where the admin put it: small buys to agents, big ones to merchant accounts', async () => {
      await config({ merchantBuySizes: [50_000, 100_000, 500_000], merchantSellSizes: [] });
      const small = await queuedBuy(1_000);
      expect(await getOrderRecord(small.orderId)).toMatchObject({ paymentMode: 'CASH_ATM', inrRouting: 'AGENTS' });
      const p = await player();
      const big = await createOrderRecord({
        orderId: oid(), userId: p.userId, type: 'DEPOSIT', tokenAmountRupees: 50_000, fiatAmountRupees: 50_000,
      });
      expect(big).toMatchObject({ paymentMode: 'P2P_UPI', inrRouting: 'MERCHANTS' });
      const payload = systemConfigPayload(await getSystemConfig());
      expect(payload.orderSizes.buy.CASH).toContain(1_000);
      expect(payload.orderSizes.buy.MERCHANT).toEqual([50_000, 100_000, 500_000]);
      expect(payload.orderSizes.sell.MERCHANT).toEqual([]);
      // Moving 1,000 to merchant accounts moves the waiting 1,000 buy with it.
      const res = await as(systemApp, settingsAdmin).put('/system/config').send({ merchantBuySizes: [1_000, 50_000] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await getOrderRecord(small.orderId)).toMatchObject({ paymentMode: 'P2P_UPI', inrRouting: 'MERCHANTS' });
      await config({ ...TO_MERCHANTS });
    });

    it('refuses a size that is not an order size, and the database refuses to move an assigned order', async () => {
      const res = await as(systemApp, settingsAdmin).put('/system/config').send({ merchantBuySizes: [777] });
      expect(res.status).toBe(400);
      expect((await getSystemConfig()).merchantBuySizes).toEqual([...ORDER_SIZES]);
      const { rows } = await pgQuery(
        `SELECT order_id FROM order_states WHERE state = 'PROCESSING' AND inr_routing = 'AGENTS' AND user_id = ANY($1) LIMIT 1`,
        [players]);
      await expect(pgQuery(
        `UPDATE order_states SET inr_routing = 'MERCHANTS', payment_mode = 'P2P_UPI' WHERE order_id = $1`, [rows[0].order_id]))
        .rejects.toThrow(/cannot be moved/);
      // A waiting order moves only with its routing, and under merchant accounts only to UPI or bank.
      await config({ ...TO_AGENTS });
      const waiting = await queuedBuy(1_000);
      await expect(pgQuery(
        `UPDATE order_states SET inr_routing = 'MERCHANTS', payment_mode = 'CASH_ATM' WHERE order_id = $1`, [waiting.orderId]))
        .rejects.toThrow(/cannot be moved/);
      await expect(pgQuery(
        `UPDATE order_states SET payment_mode = 'P2P_UPI' WHERE order_id = $1`, [waiting.orderId]))
        .rejects.toThrow(/cannot be moved/);
      await config({ ...TO_MERCHANTS });
    });
  });

  // ── Buys, end to end ──────────────────────────────────────────────────────
  describe('a buy served by a merchant account', () => {
    let m;
    beforeAll(async () => {
      await config({ ...TO_MERCHANTS });
      m = await merchantAccount();
    });

    const endToEnd = async (tokens, expectAccount) => {
      const paise = tokens * 100;
      const { order, orderId, player: p } = await queuedBuy(tokens);
      const poolBefore = await getPool(m.team.teamId);
      expect(await tryAssignMerchant(order), 'the buy was not routed').toBe(true);
      const assigned = await getOrderRecord(orderId);
      expect(assigned).toMatchObject({
        status: 'PROCESSING', merchantId: String(m.merchantId), payAccountId: expectAccount.accountId,
        paymentMode: 'P2P_UPI', inrRouting: 'MERCHANTS',
      });
      // Held in the merchant account's pool by the assignment.
      const held = await getPool(m.team.teamId);
      expect(held.heldPaise - poolBefore.heldPaise).toBe(paise);
      expect(poolBefore.availablePaise - held.availablePaise).toBe(paise);
      // Started as it was routed (no Accept, owner 2026-10-17): where to pay is shown at once.
      const view = toPlayerOrderView(await getOrderRecord(orderId)).payTo;
      const ref = utr();
      expect((await markOrderPaid(p.userId, orderId, ref)).status).toBe('PAID');
      const before = await getBalancesPaise(p.userId);
      const teamFloat = await float('TEAM_FLOAT');
      const userFloat = await float('USER_FLOAT');
      const res = await as(panel, m).post(`/confirm/${orderId}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
      const after = await getBalancesPaise(p.userId);
      expect(after.depositBalance - before.depositBalance).toBe(paise);
      const pool = await getPool(m.team.teamId);
      expect(pool.heldPaise).toBe(poolBefore.heldPaise);
      expect(poolBefore.availablePaise - pool.availablePaise).toBe(paise);
      expect(teamFloat - await float('TEAM_FLOAT')).toBe(paise);
      expect(await float('USER_FLOAT') - userFloat).toBe(paise);
      expect((await getUtr(ref)).status).toBe('RELEASED');
      return view;
    };

    it('a UPI QR buy: the player is given a link with THIS order\'s amount', async () => {
      // 1,000 is a cash size under agents; under merchant accounts it is UPI or bank.
      const view = await endToEnd(1_000, m.upi);
      expect(view.paymentLink).toMatch(/^upi:\/\/pay\?/);
      const q = new URLSearchParams(view.paymentLink.slice('upi://pay?'.length));
      expect(q.get('pa')).toBe(m.upi.upiId);
      expect(q.get('pn')).toBe('Shop Counter');
      expect(q.get('am')).toBe('1000.00');
      expect(q.get('cu')).toBe('INR');
      expect(view.bankAccount).toBeUndefined();
    });

    it('a BANK buy: the player is given the account, never a UPI handle', async () => {
      // The bank account takes buys BEFORE the UPI one stops: switching the
      // only buy account off first would leave the sizes with no account.
      expect((await as(accountApp, m).put(`/account/payment-accounts/${m.bank.accountId}`).send({ acceptsDeposits: true })).status).toBe(200);
      expect((await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ acceptsDeposits: false })).status).toBe(200);
      try {
        const view = await endToEnd(50_000, m.bank);
        expect(view.paymentLink).toBeUndefined();
        expect(view.bankAccount).toMatchObject({ accountNo: m.bank.accountNo, ifsc: 'ICIC0004321' });
      } finally {
        await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ acceptsDeposits: true });
        await as(accountApp, m).put(`/account/payment-accounts/${m.bank.accountId}`).send({ acceptsDeposits: false });
      }
    });

    it('a paused account is no reason to route, and is not taken under its lock', async () => {
      const { directCandidates } = await import('#db/repositories/teamRouting.js');
      const { takeDepositAccountWithin } = await import('#db/repositories/merchantPaymentAccounts.js');
      const { order } = await queuedBuy(1_000);
      expect((await directCandidates(order, { cap: 10 })).map((c) => c.merchantId)).toContain(String(m.merchantId));
      await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ status: 'PAUSED' });
      try {
        expect((await directCandidates(order, { cap: 10 })).map((c) => c.merchantId)).not.toContain(String(m.merchantId));
        expect(await withTransaction((c) => takeDepositAccountWithin(c, m.merchantId, m.upi.accountId, 1_000))).toBe(null);
        // Another merchant's account is never taken for this one.
        const other = await merchantAccount({ poolTokens: 0 });
        expect(await withTransaction((c) => takeDepositAccountWithin(c, m.merchantId, other.upi.accountId, 1_000))).toBe(null);
        await onlyDirectOnline(m.merchantId);
      } finally {
        await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ status: 'ACTIVE' });
      }
    });

    it('is not routed to a merchant account with no account taking deposits', async () => {
      await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ status: 'PAUSED' });
      try {
        const { order, orderId } = await queuedBuy(1_000);
        expect(await tryAssignMerchant(order)).toBe(false);
        expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');
      } finally {
        await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ status: 'ACTIVE' });
      }
    });
  });

  // ── Sells: paid FROM one of its accounts ──────────────────────────────────
  describe('a sell served by a merchant account', () => {
    let m;
    beforeAll(async () => {
      await config({ ...TO_MERCHANTS });
      m = await merchantAccount();
    });

    it('is refused without the account it was paid from, and with one that does not pay withdrawals', async () => {
      const { orderId } = await routedSell(m, 50_000);
      const ref = utr();
      const none = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: ref });
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('PAID_FROM_ACCOUNT_REQUIRED');
      const wrong = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: ref, paidFromAccountId: m.upi.accountId });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('PAID_FROM_ACCOUNT_REQUIRED');
      // Refused BEFORE the reference was claimed: it is still the merchant's to use.
      expect(await getUtr(ref)).toBeFalsy();
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('PROCESSING');
      expect(row.paidFromAccountId ?? null).toBe(null);

      const ok = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: ref, paidFromAccountId: m.bank.accountId });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await getOrderRecord(orderId)).toMatchObject({ status: 'PAID', paidFromAccountId: m.bank.accountId });
    });

    it('the Paid transition itself refuses an account that does not pay withdrawals', async () => {
      const { stampPaidFromWithin } = await import('#db/repositories/merchantPaymentAccounts.js');
      const { orderId } = await routedSell(m, 50_000);
      await expect(withTransaction((c) => stampPaidFromWithin(c, { orderId, accountId: m.upi.accountId })))
        .rejects.toMatchObject({ code: 'PAID_FROM_ACCOUNT_REFUSED' });
      expect((await getOrderRecord(orderId)).paidFromAccountId ?? null).toBe(null);
    });
  });

  // ── Which sizes go to which account (owner, 2026-10-20) ─────────────────
  describe('which sizes go to which account', () => {
    let m;
    const ALL = [...ORDER_SIZES];
    const without = (...gone) => ALL.filter((n) => !gone.includes(n));
    const sizes = (accounts) => as(accountApp, m).put('/account/payment-accounts/sizes').send({ accounts });
    beforeAll(async () => {
      await config({ ...TO_MERCHANTS });
      m = await merchantAccount();
      // Both accounts work both ways, so sizes can be split between them.
      expect((await as(accountApp, m).put(`/account/payment-accounts/${m.bank.accountId}`).send({ acceptsDeposits: true })).status).toBe(200);
      expect((await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ paysWithdrawals: true })).status).toBe(200);
    });

    it('a new account takes every size the platform sends here, and the overview says nothing is left out', async () => {
      expect(m.upi.buySizes).toEqual(ALL);
      const view = (await as(accountApp, m).get('/account')).body;
      expect(view.sizes.required).toEqual({ DEPOSIT: ALL, WITHDRAWAL: ALL });
      expect(view.sizes.uncovered).toEqual({ DEPOSIT: [], WITHDRAWAL: [] });
    });

    it('refuses a save that leaves a size with no account, naming it, and changes nothing', async () => {
      const res = await sizes([
        { accountId: m.upi.accountId, buySizes: without(1_000), sellSizes: ALL },
        { accountId: m.bank.accountId, buySizes: without(1_000), sellSizes: without(500_000) },
      ]);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SIZES_UNCOVERED', uncovered: { DEPOSIT: [1_000], WITHDRAWAL: [] } });
      expect(res.body.message).toMatch(/₹1,000/);
      const accounts = (await as(accountApp, m).get('/account')).body.accounts;
      expect(accounts.every((a) => a.buySizes.length === ALL.length)).toBe(true);
      // A size that is not an order size is refused by name.
      const bad = await sizes([{ accountId: m.upi.accountId, buySizes: [700], sellSizes: ALL }]);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_ORDER_SIZES');
      // Another merchant's account is not this merchant's to set.
      const other = await merchantAccount({ poolTokens: 0 });
      await onlyDirectOnline(m.merchantId);
      expect((await sizes([{ accountId: other.upi.accountId, buySizes: ALL, sellSizes: ALL }])).status).toBe(404);
      // Unticking the only account's size one by one is refused too.
      const one = await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ buySizes: without(1_000) });
      expect(one.status).toBe(200);
      const last = await as(accountApp, m).put(`/account/payment-accounts/${m.bank.accountId}`).send({ buySizes: without(1_000) });
      expect(last.status).toBe(409);
      expect(last.body.uncovered).toEqual({ DEPOSIT: [1_000], WITHDRAWAL: [] });
      // …and so is removing the account that was the last to take it.
      const gone = await as(accountApp, m).delete(`/account/payment-accounts/${m.bank.accountId}`);
      expect(gone.status).toBe(409);
      expect((await as(accountApp, m).put(`/account/payment-accounts/${m.upi.accountId}`).send({ buySizes: ALL })).status).toBe(200);
    });

    it('a buy goes only to the account that takes its size', async () => {
      const saved = await sizes([
        { accountId: m.upi.accountId, buySizes: without(1_000), sellSizes: ALL },
        { accountId: m.bank.accountId, buySizes: [1_000], sellSizes: ALL },
      ]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      try {
        // Asked again where the account is taken, under its lock (trap 18).
        const { takeDepositAccountWithin } = await import('#db/repositories/merchantPaymentAccounts.js');
        expect(await withTransaction((c) => takeDepositAccountWithin(c, m.merchantId, m.upi.accountId, 1_000))).toBe(null);
        for (const [tokens, account] of [[1_000, m.bank], [5_000, m.upi]]) {
          const { order, orderId } = await queuedBuy(tokens);
          await onlyDirectOnline(m.merchantId);
          expect(await tryAssignMerchant(order), `the ${tokens} buy was not routed`).toBe(true);
          expect((await getOrderRecord(orderId)).payAccountId).toBe(account.accountId);
          await pgQuery("UPDATE order_states SET state = 'CANCELLED' WHERE order_id = $1", [orderId]).catch(() => {});
          const { releaseBuyHold } = await import('#db/repositories/teamPools.js');
          await releaseBuyHold(orderId, { actor: 'test' });
        }
      } finally {
        expect((await sizes([
          { accountId: m.upi.accountId, buySizes: ALL, sellSizes: ALL },
          { accountId: m.bank.accountId, buySizes: ALL, sellSizes: ALL },
        ])).status).toBe(200);
      }
    });

    it('a sell is marked paid only from an account that takes its size', async () => {
      expect((await sizes([
        { accountId: m.upi.accountId, buySizes: ALL, sellSizes: [50_000] },
        { accountId: m.bank.accountId, buySizes: ALL, sellSizes: without(50_000) },
      ])).status).toBe(200);
      try {
        const { orderId } = await routedSell(m, 50_000);
        const ref = utr();
        const wrong = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: ref, paidFromAccountId: m.bank.accountId });
        expect(wrong.status).toBe(400);
        expect(wrong.body.code).toBe('PAID_FROM_ACCOUNT_REQUIRED');
        const { stampPaidFromWithin } = await import('#db/repositories/merchantPaymentAccounts.js');
        await expect(withTransaction((c) => stampPaidFromWithin(c, { orderId, accountId: m.bank.accountId })))
          .rejects.toMatchObject({ code: 'PAID_FROM_ACCOUNT_REFUSED' });
        const ok = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: ref, paidFromAccountId: m.upi.accountId });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await getOrderRecord(orderId)).toMatchObject({ status: 'PAID', paidFromAccountId: m.upi.accountId });
      } finally {
        await sizes([
          { accountId: m.upi.accountId, buySizes: ALL, sellSizes: ALL },
          { accountId: m.bank.accountId, buySizes: ALL, sellSizes: ALL },
        ]);
      }
    });

    it('a size the admin sends here later shows as left out until an account takes it', async () => {
      await config({ merchantBuySizes: [500, 1_000], merchantSellSizes: [500] });
      try {
        // Only 500 and 1,000 are required now, so an account may drop the rest.
        expect((await sizes([
          { accountId: m.upi.accountId, buySizes: [500, 1_000], sellSizes: [500] },
          { accountId: m.bank.accountId, buySizes: [], sellSizes: [] },
        ])).status).toBe(200);
        await config({ merchantBuySizes: [500, 1_000, 5_000], merchantSellSizes: [500] });
        const view = (await as(accountApp, m).get('/account')).body;
        expect(view.sizes.uncovered).toEqual({ DEPOSIT: [5_000], WITHDRAWAL: [] });
        // A save that does not cover it is refused; one that does lands.
        expect((await as(accountApp, m).put(`/account/payment-accounts/${m.bank.accountId}`).send({ label: 'Renamed' })).status).toBe(200);
        expect((await sizes([{ accountId: m.bank.accountId, buySizes: [], sellSizes: [] }])).status).toBe(409);
        expect((await sizes([{ accountId: m.bank.accountId, buySizes: [5_000], sellSizes: [] }])).status).toBe(200);
      } finally {
        await config({ ...TO_MERCHANTS });
        await sizes([
          { accountId: m.upi.accountId, buySizes: ALL, sellSizes: ALL },
          { accountId: m.bank.accountId, buySizes: ALL, sellSizes: ALL },
        ]);
      }
    });
  });

  // ── Sub-members ───────────────────────────────────────────────────────────
  describe('sub-members and their roles', () => {
    let m;
    beforeAll(async () => {
      await config({ ...TO_MERCHANTS });
      m = await merchantAccount();
    });

    it('writes are the owner\'s; a DEPOSITS member works only the buys paid into their accounts', async () => {
      const desk = await addStaff(m, ['DEPOSITS']);
      const s = staffSession(m, desk);
      const overview = await as(accountApp, s).get('/account');
      expect(overview.status).toBe(200);
      expect(overview.body.staff).toBeUndefined();
      // Their profile is the account's, without the owner's mobile or payout details (§24).
      const profile = await as(panel, s).get('/profile');
      expect(profile.status).toBe(200);
      for (const k of ['mobile', 'email', 'username', 'bankDetails']) expect(profile.body.merchant).not.toHaveProperty(k);
      expect(profile.body.actor.isOwner).toBe(false);
      expect((await as(panel, m).get('/profile')).body.merchant).toHaveProperty('mobile');
      expect((await as(panel, s).put('/online-status').send({ isOnline: false })).body.code).toBe('OWNER_ONLY');
      expect((await as(accountApp, s).post('/account/payment-accounts').send({})).body.code).toBe('OWNER_ONLY');
      expect((await as(accountApp, s).post('/account/staff').send({})).body.code).toBe('OWNER_ONLY');
      expect((await as(accountApp, s).get('/account/reports')).body.code).toBe('ROLE_REQUIRED');

      const { order, orderId, player: p } = await queuedBuy(1_000);
      await onlyDirectOnline(m.merchantId);
      expect(await tryAssignMerchant(order)).toBe(true);
      // The player pays and taps Paid; the confirm is the desk's work.
      expect((await markOrderPaid(p.userId, orderId, utr())).status).toBe('PAID');
      const unassigned = await as(panel, s).post(`/confirm/${orderId}`).send({});
      expect(unassigned.status).toBe(403);
      expect(unassigned.body.code).toBe('ACCOUNT_NOT_ASSIGNED');
      expect((await getOrderRecord(orderId)).status).toBe('PAID');
      // A WITHDRAWAL duty is refused for a member without that role.
      const badDuty = await as(accountApp, m).post(`/account/staff/${desk.staffId}/accounts`)
        .send({ accountId: m.bank.accountId, duty: 'WITHDRAWAL' });
      expect(badDuty.status).toBe(409);
      const given = await as(accountApp, m).post(`/account/staff/${desk.staffId}/accounts`)
        .send({ accountId: m.upi.accountId, duty: 'DEPOSIT' });
      expect(given.status, JSON.stringify(given.body)).toBe(200);
      const confirmed = await as(panel, s).post(`/confirm/${orderId}`).send({});
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
      // The report names who pressed ✓ (owner, 2026-10-16): the desk, by name,
      // to the owner and to the desk; the CSV says the same.
      for (const who of [m, s]) {
        const report = await as(panel, who).get('/reports/orders');
        expect(report.status, JSON.stringify(report.body)).toBe(200);
        const row = report.body.rows.find((r) => r.orderId === orderId);
        expect(row).toMatchObject({ result: 'CONFIRMED', actedBy: { kind: 'STAFF', name: desk.name }, type: 'DEPOSIT' });
        expect(row.tokenAmount).toBe(1_000);
        expect(Object.keys(row).every((k) => ['orderId', 'type', 'userId', 'utr', 'tokenAmount', 'state', 'result', 'actedBy', 'at'].includes(k))).toBe(true);
      }
      const csvLine = (await as(panel, m).get('/reports/orders.csv')).text.split('\n').find((l) => l.startsWith(orderId));
      expect(csvLine).toContain('✓');
      expect(csvLine).toContain(desk.name);
      // Their list shows the buys paid into their account.
      const list = await as(panel, s).get('/orders');
      expect(list.status).toBe(200);
      const ids = (list.body.orders ?? list.body.data ?? []).map((o) => o.orderId ?? o._id);
      expect(ids).toContain(orderId);

      // A sell is not theirs.
      const sell = await routedSell(m, 50_000);
      const refused = await as(panel, s).post(`/confirm/${sell.orderId}`).send({ utrNumber: utr(), paidFromAccountId: m.bank.accountId });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ROLE_REQUIRED');
    });

    it('a change of roles ends the old session; AUDIT reads the reports and writes nothing', async () => {
      const desk = await addStaff(m, ['DEPOSITS']);
      const old = staffSession(m, desk);
      expect((await as(accountApp, old).get('/account')).status).toBe(200);
      const changed = await as(accountApp, m).put(`/account/staff/${desk.staffId}/roles`).send({ roles: ['AUDIT'] });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect((await as(accountApp, old).get('/account')).status).toBe(401);

      const fresh = staffSession(m, desk);
      const report = await as(accountApp, fresh).get('/account/reports');
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      expect(report.body.totals).toBeTruthy();
      const csv = await as(panel, fresh).get('/reports/orders.csv');
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const { order, orderId } = await queuedBuy(1_000);
      await onlyDirectOnline(m.merchantId);
      expect(await tryAssignMerchant(order)).toBe(true);
      expect((await as(panel, fresh).post(`/reject/${orderId}`).send({ reason: 'Not mine to take' })).body.code).toBe('ROLE_REQUIRED');

      expect((await as(accountApp, m).delete(`/account/staff/${desk.staffId}`)).status).toBe(200);
      expect((await as(accountApp, staffSession(m, desk)).get('/account')).status).toBe(401);
    });

    it('a sub-member of another merchant account is refused at this one', async () => {
      const other = await merchantAccount({ poolTokens: 0 });
      const theirs = await addStaff(other, ['AUDIT']);
      const forged = staffSession(m, theirs);
      expect((await as(accountApp, forged).get('/account')).status).toBe(401);
      await onlyDirectOnline(m.merchantId);
    });

    it('a merchant that is not a merchant account is answered so', async () => {
      const agent = await merchantActor();
      const res = await as(accountApp, agent).get('/account');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_A_MERCHANT_ACCOUNT');
    });
  });

  // ── Problems flag; they do not suspend ────────────────────────────────────
  describe('problems', () => {
    it('flags a merchant account at the admin\'s daily threshold, and never suspends it', async () => {
      await config({ ...TO_MERCHANTS, directMerchants: { dailyProblemFlagThreshold: 2 } });
      const m = await merchantAccount();
      const cap = Number((await getSystemConfig()).merchantOrderLimits?.maxConsecutiveRejections ?? 3);
      // Each refusal a declined sell: a started buy shows the player where to
      // pay at once, so it is never declined (owner, 2026-10-17).
      for (let i = 0; i < Math.max(cap, 2) + 1; i += 1) {
        const { orderId } = await routedSell(m, 50_000);
        const declined = await as(panel, m).post(`/reject/${orderId}`).send({ reason: 'Counter closed' });
        expect(declined.status, JSON.stringify(declined.body)).toBe(200);
      }
      const merchant = await getMerchant(m.merchantId);
      expect(merchant.status).toBe('ACTIVE');
      expect(merchant.assignmentPausedAt ?? null).toBe(null);
      const { rows: problems } = await pgQuery(
        `SELECT kind FROM merchant_problems WHERE merchant_id = $1`, [m.merchantId]);
      expect(problems.length).toBe(Math.max(cap, 2) + 1);
      expect(problems.every((p) => p.kind === 'REFUSAL')).toBe(true);
      // Flagged ONCE that day, at the threshold.
      const flags = await as(adminApp, admin).get(`/merchant-flags?merchantId=${m.merchantId}`);
      expect(flags.status).toBe(200);
      expect(flags.body.flags).toHaveLength(1);
      expect(flags.body.flags[0]).toMatchObject({ problemCount: 2, threshold: 2 });
    });

    it('a lost dispute is a problem for a merchant account, not a suspension', async () => {
      await config({ ...TO_MERCHANTS });
      const { recordDisputeFault } = await import('#db/repositories/disputeFaults.js');
      const m = await merchantAccount();
      const { order, orderId } = await queuedBuy(1_000);
      await onlyDirectOnline(m.merchantId);
      expect(await tryAssignMerchant(order)).toBe(true);
      const out = await recordDisputeFault({
        orderId, party: 'MERCHANT', merchantId: m.merchantId, decision: 'COMPLETE', decidedBy: admin.userId,
      });
      expect(out).toMatchObject({ ok: true, party: 'MERCHANT', lostCount: 1, suspended: false });
      expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
      const { rows } = await pgQuery('SELECT kind, order_id FROM merchant_problems WHERE merchant_id = $1', [m.merchantId]);
      expect(rows).toEqual([{ kind: 'DISPUTE_LOST', order_id: orderId }]);
    });

    it('an AGENT\'s refusals still suspend at the cap', async () => {
      await config({ ...TO_AGENTS });
      await onlyDirectOnline(null);
      const agent = await merchantActor();
      await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 200_000, include: [agent.merchantId] });
      const cap = Number((await getSystemConfig()).merchantOrderLimits?.maxConsecutiveRejections ?? 3);
      for (let i = 0; i < cap; i += 1) {
        // A sell the agent declines (a started buy cannot be declined).
        const p = await player();
        await updateUser(p.userId, {
          bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
        });
        await creditWinnings(p.userId, 50_000, 'merchant account suite float', 'Test', `seed_${p.userId}`, `mac_seed_${p.userId}`);
        await teams.onlyOnline([agent.merchantId]);
        const { order: created } = await createWithdrawalOrder(p.userId, 50_000);
        const orderId = created.orderId ?? created._id;
        expect((await getOrderRecord(orderId)).merchantId).toBe(String(agent.merchantId));
        expect((await as(panel, agent).post(`/reject/${orderId}`).send({ reason: 'busy' })).status).toBe(200);
      }
      expect((await getMerchant(agent.merchantId)).status).toBe('SUSPENDED');
      const { rows } = await pgQuery('SELECT 1 FROM merchant_problems WHERE merchant_id = $1', [agent.merchantId]);
      expect(rows).toHaveLength(0);
    });
  });

  // ── Commission ────────────────────────────────────────────────────────────
  describe('commission', () => {
    it('pays the admin\'s percent of the matched rise into the account\'s own pool, all of it the owner\'s', async () => {
      await config({ ...TO_MERCHANTS, directMerchants: { commissionPercent: 7 } });
      const m = await merchantAccount({ poolTokens: 200_000 });
      // The platform's commission pool, funded from revenue for this case.
      const need = 10_000_000 - await bonusPoolPaise();
      if (need) {
        const postings = [{ account: POOL, amountPaise: -need }, { account: 'PLATFORM_REVENUE', amountPaise: need }];
        posted.push(...postings);
        await recordEvent({
          eventType: 'ADJUSTMENT', idempotencyKey: `mac-test-adj-${RUN}`, postings,
          refModel: 'Test', refId: 'merchantAccountPg', description: 'merchantAccountPg: fund the commission pool',
        });
      }
      const { order, orderId, player: p } = await queuedBuy(50_000);
      await onlyDirectOnline(m.merchantId);
      expect(await tryAssignMerchant(order)).toBe(true);
      expect((await markOrderPaid(p.userId, orderId, utr())).status).toBe('PAID');
      expect((await as(panel, m).post(`/confirm/${orderId}`).send({})).status).toBe(200);

      const sell = await routedSell(m, 50_000);
      const paid = await as(panel, m).post(`/confirm/${sell.orderId}`).send({ utrNumber: utr(), paidFromAccountId: m.bank.accountId });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      const poolBefore = (await getPool(m.team.teamId)).availablePaise;
      expect(await settleHold(sell.orderId)).toBe(true);

      const { rows } = await pgQuery('SELECT * FROM team_commissions WHERE team_id = $1', [m.team.teamId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from_high_paise: '0', to_high_paise: '5000000', commission_paise: '350000', commission_percent: 7,
      });
      expect(rows[0].supervisor_id).toBe(null);
      const { rows: shares } = await pgQuery(
        'SELECT role, merchant_id, share_paise FROM team_commission_shares WHERE commission_id = $1', [rows[0].commission_id]);
      expect(shares).toEqual([{ role: 'OWNER', merchant_id: String(m.merchantId), share_paise: '350000' }]);
      // The sell's tokens and the commission both landed in the account's own pool.
      expect((await getPool(m.team.teamId)).availablePaise - poolBefore).toBe(5_000_000 + 350_000);
      const summary = (await as(accountApp, m).get('/account')).body.team.commission;
      expect(summary).toMatchObject({ commissionPercent: 7, supervisorSharePercent: 0 });
    });
  });

  // ── A mobile never reaches a player as a UPI ID ───────────────────────────
  describe('a mobile in a UPI ID or payee name', () => {
    let m;
    beforeAll(async () => { m = await merchantAccount({ poolTokens: 0 }); });

    const add = (patch) => as(accountApp, m).post('/account/payment-accounts').send({
      kind: 'UPI_QR', label: 'Phone QR', holderName: 'Shop Counter', accountNo: '66210045678', ifsc: 'SBIN0001234',
      bankName: 'SBI', ...patch,
    });

    it('is refused when the UPI ID is a mobile', async () => {
      const res = await add({ upiLink: 'upi://pay?pa=9876543210@ybl&pn=Shop&cu=INR' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_UPI_QR');
    });

    it('is refused when the payee name carries a mobile', async () => {
      const res = await add({ upiLink: `upi://pay?pa=desk${RUN}@okaxis&pn=Call%2098765%2043210&cu=INR` });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_UPI_QR');
    });

    it('is refused when the QR fixes an amount (a static QR names none)', async () => {
      const res = await add({ upiLink: `upi://pay?pa=desk${RUN}@okaxis&pn=Shop&am=500.00&cu=INR` });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_UPI_QR');
    });

    it('is refused by the ROW, whoever writes it', async () => {
      await expect(pgQuery(
        `INSERT INTO merchant_payment_accounts (account_id, merchant_id, kind, label, upi_link, upi_pa, upi_pn,
            holder_name, account_no, ifsc, bank_name)
         VALUES ($1, $2, 'UPI_QR', 'raw', 'upi://pay?pa=9876543210@ybl&pn=Shop', '9876543210@ybl', 'Shop',
            'Shop', '66210045678', 'SBIN0001234', 'SBI')`,
        [`mpa_raw_${RUN}`, m.merchantId]))
        .rejects.toMatchObject({ constraint: 'merchant_payment_accounts_not_a_mobile' });
    });

    it('is refused on a holder name carrying a mobile, in the account owner\'s words', async () => {
      const res = await as(accountApp, m).post('/account/payment-accounts').send({
        kind: 'BANK', label: 'Main', holderName: 'Ravi 9876543210', accountNo: '66210045699', ifsc: 'SBIN0001234', bankName: 'SBI',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ACCOUNT_IS_A_MOBILE');
    });
  });
});

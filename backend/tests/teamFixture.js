// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Working teams for tests (PROJECT_STATUS §3.10, Step 2c).
 *
 * Every order now reaches a MEMBER of a WORKING team (ten approved members)
 * whose supervisor is on the order's rail, and a buy holds its tokens in that
 * team's pool. A test that wants an order served by a particular merchant
 * therefore needs that merchant inside such a team, online, with the pool
 * funded — built through the real repositories, never by writing rows a
 * platform could not produce (§32 S16).
 *
 *   const teams = teamFixture();
 *   const { members, teamId } = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 5000, include: [m.merchantId] });
 *   ...
 *   afterAll(() => teams.cleanup());   // before closePg()
 *
 * `include` puts existing merchants in the team (they must be ACTIVE and
 * APPROVED); the team is padded to ten with fresh ones. `online` names who is
 * online among EVERY team member in the database — by default the included
 * merchants when there are any, otherwise all ten — so routing is
 * deterministic even when an earlier suite left a team behind.
 *
 * Trap 10: everything this creates is removed by `cleanup()`, with the orders'
 * pool entries and the payments recorded for the pool.
 */
import { randomBytes } from 'node:crypto';
import { pgQuery } from '#db/client.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '#db/repositories/merchants.js';
import { setSupervisorRole, createTeam, addMember, approveMember } from '#db/repositories/teams.js';
import { createRequest, fulfilRequest } from '#db/repositories/teamPools.js';
import { getOrderRecord, setCashLink } from '#db/repositories/orders.record.js';
import { PAYMENT_MODES } from '#db/repositories/orderRails.js';
import { checkCashLink } from '../domains/payment/cashLink.js';
import { startOrder } from '../domains/payment/orderLifecycle.service.js';

let seq = 0;

export function teamFixture() {
  const merchants = [];
  const teams = [];

  async function freshMerchant(prefix = 'TF') {
    const merchantId = newMerchantId();
    seq += 1;
    await createMerchant({
      merchantId, name: `${prefix} ${merchantId.slice(-6)}`, publicRef: generateMerchantPublicRef(),
      mobile: `4${String(Date.now()).slice(-6)}${String(seq % 1000).padStart(3, '0')}`, status: 'ACTIVE',
      // The account a bank-transfer buy is paid into (owner, 2026-10-03).
      bankDetails: {
        upiId: `tf${randomBytes(5).toString('hex')}@upi`,
        accountHolderName: `${prefix} Holder`, bankName: 'Test Bank',
        accountNo: `5020${String(Date.now()).slice(-6)}${String(seq % 100).padStart(2, '0')}`, ifsc: 'TEST0000001',
      },
    });
    await updateMerchant(merchantId, { merchantApprovalStatus: 'APPROVED' });
    merchants.push(merchantId);
    return merchantId;
  }

  /** Who is online among every team member in the database. */
  async function onlyOnline(ids) {
    await pgQuery(
      `UPDATE merchants SET is_online = (merchant_id = ANY($1))
        WHERE merchant_id IN (SELECT merchant_id FROM team_members)`, [ids.map(String)]);
  }

  /** Buy `tokens` into a team's pool, through the supervisor's request and the admin's fulfilment. */
  async function fund(team, tokens) {
    const r = await createRequest({ teamId: team.teamId, supervisorId: team.supervisorId, direction: 'BUY', tokenAmountPaise: tokens * 100 });
    if (!r.ok) throw new Error(`teamFixture: pool request refused: ${r.reason}`);
    const done = await fulfilRequest({
      requestId: r.requestId, actor: 'test-admin',
      consideration: { currency: 'INR', fiatAmountMinor: tokens * 100, rateUsed: null },
    });
    if (!done.ok) throw new Error(`teamFixture: pool fulfilment refused: ${done.reason}`);
  }

  async function workingTeam({ rail = 'UPI_BANK', poolTokens = 0, include = [], online = null } = {}) {
    const supervisorId = await freshMerchant('TF sup');
    const role = await setSupervisorRole(supervisorId, { rail });
    if (!role.ok) throw new Error(`teamFixture: supervisor refused: ${role.reason}`);
    const { teamId } = await createTeam({ supervisorId, name: `TF ${teams.length + 1}` });
    teams.push(teamId);
    const members = [...include.map(String)];
    while (members.length < 10) members.push(await freshMerchant());
    for (const m of members) {
      const added = await addMember({ teamId, supervisorId, merchantRef: m, actor: supervisorId });
      if (!added.ok) throw new Error(`teamFixture: add ${m} refused: ${added.reason}`);
      const approved = await approveMember({ merchantId: m, actor: 'test-admin' });
      if (!approved.ok) throw new Error(`teamFixture: approve ${m} refused: ${approved.reason}`);
    }
    await onlyOnline(online ?? (include.length ? include : members));
    const team = { teamId, supervisorId, members, rail };
    if (poolTokens > 0) await fund(team, poolTokens);
    return team;
  }

  async function cleanup() {
    if (!teams.length && !merchants.length) return;
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [teams]);
      await pgQuery(
        'DELETE FROM team_commission_shares WHERE commission_id IN (SELECT commission_id FROM team_commissions WHERE team_id = ANY($1))',
        [teams]);
      await pgQuery('DELETE FROM team_commissions WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pools WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_members WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM teams WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [merchants]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    teams.length = 0;
    merchants.length = 0;
  }

  return { workingTeam, fund, onlyOnline, freshMerchant, cleanup };
}

/**
 * What has to happen on the member's side before a player can pay a buy
 * (Step 2d): the member ACCEPTS it (until then they may still decline, so the
 * player is shown nowhere to pay), and on a CASH buy scans the machine's QR.
 * Through the transition the accept route makes, and the check and the one
 * writer the scan route uses. A no-op on anything already past that, so a
 * fixture can call it before every Paid tap.
 */
export async function readyToPay(orderId) {
  let order = await getOrderRecord(orderId);
  if (!order || order.type !== 'DEPOSIT') return order;
  if (order.status === 'ASSIGNED') {
    const accepted = await startOrder(order.orderId, {
      expectFrom: ['ASSIGNED'], expectMerchant: order.merchantId, set: { processingAt: new Date() },
    });
    if (!accepted.ok) throw new Error(`readyToPay: ${orderId} could not be accepted (${accepted.reason})`);
    order = await getOrderRecord(orderId);
  }
  if (order.paymentMode !== PAYMENT_MODES.CASH_ATM || order.cashLink || order.status !== 'PROCESSING') return order;
  const tr = String(order.orderId).replace(/[^A-Za-z0-9]/g, '').slice(-20);
  const link = checkCashLink(
    `upi://pay?pa=atm.cash@icici&pn=ATM&am=${Number(order.fiatAmount).toFixed(2)}&cu=INR&tr=${tr}`,
    order.fiatAmount,
  );
  const scanned = await setCashLink(order.orderId, order.merchantId, link);
  if (!scanned) throw new Error(`readyToPay: ${orderId} is not a cash buy waiting for its QR (${order.status})`);
  return scanned;
}

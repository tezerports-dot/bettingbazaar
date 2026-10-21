// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant buys pool tokens from the platform in USDT, the way a player
 * buys tokens (owner, 2026-10-21): an address of the request's own, the price
 * frozen at `usdtPricing.merchantAdminBuyInr`, and the tokens in the pool once
 * the USDT covers it, with no admin step. Against a real database; the chain
 * is only ever the transfers the test records, as the watcher records them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { creditPoolIfCovered, openMerchantPoolUsdtBuy } from '../../domains/payment/usdtDeposit.service.js';
import { configuredAccountKey, deriveDepositAddress } from '../../domains/payment/usdtBsc.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The account xpub of BIP-39 test vector "abandon … about" at m/44'/60'/0'.
const TEST_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';
const hex64 = () => `0x${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;

describePg('USDT pool buys (PostgreSQL)', () => {
  const teams = teamFixture();
  const env = {};
  let priorPricing = null;
  let merchantApp;
  let adminApp;
  let admin;

  const setEnv = (k, v) => { env[k] = process.env[k]; process.env[k] = v; };
  const pay = (address, usdt) => db.usdtDeposits.recordTransfer({
    txHash: hex64(), logIndex: 0, to: address, from: `0x${'1'.repeat(40)}`, amountMicro: BigInt(Math.round(usdt * 1e6)), blockNumber: 100,
  });
  const session = (merchantId) => ({
    auth: `Bearer ${signToken({ merchantId, userId: merchantId, mobile: '9000000000', isMerchant: true, isAdmin: false, amr: ['tg'] })}`,
  });

  beforeAll(async () => {
    await applySchema();
    setEnv('USDT_BEP20_XPUB', TEST_XPUB);
    setEnv('BSC_RPC_URL', 'http://bsc.test/rpc');
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    await applySystemConfig({ usdtPricing: { merchantAdminBuyInr: 90 } }, { actor: 'usdt-pool-suite' });
    merchantApp = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../domains/team/team.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-pool-suite' });
    await teams.cleanup();
    await closePg();
  });

  it('opens the buy with its own address and a frozen price, and the pool fills by itself once the USDT covers it', async () => {
    const team = await teams.workingTeam();
    const res = await as(merchantApp, session(team.supervisorId))
      .post(`/supervisor/teams/${team.teamId}/pool-requests/usdt`).send({ tokenAmount: 9_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { request } = res.body;
    expect(request).toMatchObject({ direction: 'BUY', status: 'PENDING', tokenAmountPaise: 900_000 });
    // ₹9,000 at ₹90 a USDT is 100 USDT, on BNB Smart Chain.
    expect(request.usdt).toMatchObject({ chain: 'BEP20', amount: 100, received: 0, rate: 90 });
    const { rows: [row] } = await pgQuery('SELECT derivation_index FROM pool_usdt_addresses WHERE request_id = $1', [request.requestId]);
    expect(deriveDepositAddress(configuredAccountKey(), row.derivation_index)).toBe(request.usdt.address);
    // The price never changes once written.
    await expect(pgQuery('UPDATE pool_usdt_addresses SET usdt_micro = 1 WHERE request_id = $1', [request.requestId])).rejects.toThrow();

    const supplyBefore = (await getTreasuryBalances())[ACCOUNTS.TOKEN_SUPPLY];
    // Part of it: nothing moves, and the request can no longer be withdrawn.
    expect(await pay(request.usdt.address, 60)).toMatchObject({ recorded: true, requestId: request.requestId, requestStatus: 'PENDING' });
    expect(await creditPoolIfCovered(request.requestId)).toMatchObject({ credited: false, reason: 'not_covered' });
    expect((await getPool(team.teamId)).availablePaise).toBe(0);
    const cancel = await as(merchantApp, session(team.supervisorId)).delete(`/supervisor/pool-requests/${request.requestId}`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('usdt_received');
    // Nor does an admin fulfil it by hand.
    const byHand = await as(adminApp, admin).post(`/team-pool-requests/${request.requestId}/fulfil`)
      .send({ settlementCurrency: 'INR', settlementAmount: 9_000 });
    expect(byHand.status).toBe(409);
    expect(byHand.body.code).toBe('usdt_paid_on_chain');

    // The rest: the pool, the treasury and the consideration move together, once.
    await pay(request.usdt.address, 40);
    expect(await creditPoolIfCovered(request.requestId)).toMatchObject({ credited: true, tokenAmountPaise: 900_000 });
    expect(await creditPoolIfCovered(request.requestId)).toMatchObject({ credited: false, reason: 'not_pending' });
    expect((await getPool(team.teamId)).availablePaise).toBe(900_000);
    expect((await getTreasuryBalances())[ACCOUNTS.TOKEN_SUPPLY]).toBe(supplyBefore - 900_000);
    const { rows: [c] } = await pgQuery(
      'SELECT currency, fiat_amount_minor, inr_equivalent_paise, rate_used FROM admin_token_considerations WHERE movement_id = $1',
      [`team_pool_${request.requestId}`]);
    expect(c).toMatchObject({ currency: 'USDT', fiat_amount_minor: '10000', inr_equivalent_paise: '900000' });
    expect((await db.teamPools.getRequest(request.requestId)).status).toBe('FULFILLED');
    expect(await db.teamPools.poolTradeTotals(team.teamId)).toMatchObject({ boughtPaise: 900_000, buys: 1 });

    // A sweep line names the request, once it is no longer waiting.
    const sweep = await db.usdtDeposits.sweepCandidates();
    expect(sweep.find((s) => s.orderId === request.requestId)).toMatchObject({ address: request.usdt.address, usdtReceived: 100 });
  });

  it('refuses a second waiting buy for the same pool, and an unpriced one, writing nothing', async () => {
    const team = await teams.workingTeam();
    const first = await openMerchantPoolUsdtBuy({ teamId: team.teamId, supervisorId: team.supervisorId, tokenAmountPaise: 100_000 });
    expect(first.ok).toBe(true);
    const second = await openMerchantPoolUsdtBuy({ teamId: team.teamId, supervisorId: team.supervisorId, tokenAmountPaise: 100_000 });
    expect(second).toEqual({ ok: false, reason: 'request_pending' });
    // Another's team matches nothing.
    const other = await teams.freshMerchant();
    expect(await openMerchantPoolUsdtBuy({ teamId: team.teamId, supervisorId: other, tokenAmountPaise: 100_000 }))
      .toEqual({ ok: false, reason: 'team_not_found' });
    await applySystemConfig({ usdtPricing: { merchantAdminBuyInr: 0 } }, { actor: 'usdt-pool-suite' });
    try {
      const fresh = await teams.workingTeam();
      await expect(openMerchantPoolUsdtBuy({ teamId: fresh.teamId, supervisorId: fresh.supervisorId, tokenAmountPaise: 100_000 }))
        .rejects.toMatchObject({ status: 409, code: 'USDT_RATE_UNSET' });
      expect(await db.teamPools.listRequests({ teamId: fresh.teamId })).toEqual([]);
    } finally {
      await applySystemConfig({ usdtPricing: { merchantAdminBuyInr: 90 } }, { actor: 'usdt-pool-suite' });
    }
  });

  it('an unpaid buy past its window lapses; one with money on it stays for an admin', async () => {
    const team = await teams.workingTeam();
    const unpaid = await openMerchantPoolUsdtBuy({ teamId: team.teamId, supervisorId: team.supervisorId, tokenAmountPaise: 90_000 });
    // The schema refuses moving the window, so a past one is written with the trigger off.
    const backdate = async (requestId) => {
      await pgQuery('SET session_replication_role = replica');
      try {
        await pgQuery("UPDATE pool_usdt_addresses SET expires_at = now() - interval '1 minute' WHERE request_id = $1", [requestId]);
      } finally { await pgQuery('SET session_replication_role = DEFAULT'); }
    };
    await backdate(unpaid.requestId);
    expect(await db.usdtDeposits.lapsePoolUsdtBuy(unpaid.requestId)).toBe(true);
    expect((await db.teamPools.getRequest(unpaid.requestId)).status).toBe('CANCELLED');

    const short = await openMerchantPoolUsdtBuy({ teamId: team.teamId, supervisorId: team.supervisorId, tokenAmountPaise: 90_000 });
    await pay(short.address, 0.5);
    await backdate(short.requestId);
    expect(await db.usdtDeposits.lapsePoolUsdtBuy(short.requestId)).toBe(false);
    const listed = (await db.usdtDeposits.listPoolDeposits()).find((r) => r.requestId === short.requestId);
    expect(listed).toMatchObject({ status: 'PENDING', attention: 'SHORT', usdtReceived: 0.5, usdtRequired: 10 });
    // An admin settles it, notes what was done, and the request is turned down.
    expect((await db.usdtDeposits.markHandled(short.requestId, { actor: 'admin:t', note: 'Refunded 0.5 USDT' })).marked).toBe(1);
  });
});

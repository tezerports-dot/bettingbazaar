// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The merchant record, against a real PostgreSQL.
 *
 * A merchant settles real INR and USDT, so the properties worth testing are the
 * ones that decide where money goes: which rail they are on, which credentials
 * money is sent to, whether they can be routed an order, and whether the
 * counters an operator reads describe the orders that actually happened.
 *
 * Three of these assert something the document model could NOT enforce:
 *   • `public_ref` immutability, which `immutable: true` honours on a document
 *     save and ignores on an update operator;
 *   • `merchant_type`, a GENERATED column rather than a virtual, so the scalar
 *     panels read cannot drift from the array assignment filters on;
 *   • the active order count, DERIVED from rows rather than accumulated — the
 *     document store's counter lost its decrement to any crash and throttled
 *     the merchant permanently.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  createMerchant, createMerchantWithWallet, getMerchant, getMerchants,
  getMerchantByUserId, getMerchantByPublicRef, getMerchantByLogin,
  getMerchantCredentials, getActiveOrderCounts, listAssignableMerchants,
  listMerchants, merchantCounts, updateMerchant, setOnline,
  recordCompletedOrder, resetPeriodicStats, suspendMerchant, approveMerchant,
  rejectMerchant, deleteMerchant, generateMerchantPublicRef, newMerchantId,
} from '../repositories/merchants.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the merchant record', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let ID;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(() => { seq += 1; ID = `m-${RUN}-${seq}`; });

  // A well-formed TRC-20 address: 'T' plus 33 base58 characters. Distinct per
  // call because the address is UNIQUE across merchants — two tests reusing one
  // would collide on the index rather than on the property under test.
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const trc20 = () => `T${Array.from({ length: 33 },
    () => BASE58[Math.floor(Math.random() * BASE58.length)]).join('')}`;

  const make = (over = {}) => createMerchant({
    merchantId: ID, name: `Merchant ${seq}`, status: 'ACTIVE', ...over,
  });

  // ── Identity ──────────────────────────────────────────────────────────────
  it('creates and reads back a merchant', async () => {
    const created = await make({ mobile: `9${RUN}${seq}`, email: 'm@example.com' });
    expect(created.merchantId).toBe(ID);
    expect(created.publicRef).toMatch(/^M[0-9A-F]{16}$/);

    const read = await getMerchant(ID);
    expect(read.name).toBe(`Merchant ${seq}`);
    expect(read.status).toBe('ACTIVE');
  });

  it('REFUSES to change public_ref — the reference is on receipts players hold', async () => {
    // `immutable: true` in the document model is honoured by a document save
    // and skipped by an update operator, which is not immutability. Here it is
    // a trigger, so there is no path around it.
    await make();
    await expect(
      pgQuery('UPDATE merchants SET public_ref = $2 WHERE merchant_id = $1',
        [ID, generateMerchantPublicRef()]),
    ).rejects.toThrow(/public_ref is immutable/);
  });

  it('gives each merchant its own public_ref and id', async () => {
    const refs = new Set();
    const ids = new Set();
    for (let i = 0; i < 20; i += 1) {
      refs.add(generateMerchantPublicRef());
      ids.add(newMerchantId());
    }
    expect(refs.size).toBe(20);
    expect(ids.size).toBe(20);
  });

  it('one account cannot be two merchants', async () => {
    const userId = `u-${RUN}-${seq}`;
    await make({ userId });
    await expect(
      createMerchant({ merchantId: `${ID}-b`, name: 'Second', userId }),
    ).rejects.toThrow(/merchants_user_id_key|duplicate key/);
  });

  it('finds a merchant by account, by public ref, and by either login identifier', async () => {
    const userId = `u-${RUN}-${seq}`;
    const created = await make({ userId, mobile: `98${RUN}${seq}`, username: `Trader${RUN}${seq}` });

    expect((await getMerchantByUserId(userId)).merchantId).toBe(ID);
    expect((await getMerchantByPublicRef(created.publicRef)).merchantId).toBe(ID);
    expect((await getMerchantByLogin(`98${RUN}${seq}`)).merchantId).toBe(ID);
    // Usernames are matched case-insensitively, or a merchant who capitalises
    // differently at the keyboard cannot sign in.
    expect((await getMerchantByLogin(`trader${RUN}${seq}`)).merchantId).toBe(ID);
  });

  it('reads several merchants in one round trip', async () => {
    await make();
    await createMerchant({ merchantId: `${ID}-b`, name: 'B' });
    const rows = await getMerchants([ID, `${ID}-b`, 'does-not-exist']);
    expect(rows.map((m) => m.merchantId).sort()).toEqual([ID, `${ID}-b`].sort());
  });

  // ── Credentials ───────────────────────────────────────────────────────────
  it('keeps credentials OUT of the general reader', async () => {
    await make({ passwordHash: 'hashed-secret' });
    const rendered = await getMerchant(ID);
    expect(JSON.stringify(rendered)).not.toContain('hashed-secret');
    expect(rendered.passwordHash).toBeUndefined();

    const creds = await getMerchantCredentials(ID);
    expect(creds.passwordHash).toBe('hashed-secret');
    expect(creds.backupCodes).toEqual([]);
  });

  it('stores recovery codes, which had no column at all on the account side', async () => {
    await make();
    await updateMerchant(ID, { backup_codes: ['h1', 'h2', 'h3'] });
    expect((await getMerchantCredentials(ID)).backupCodes).toEqual(['h1', 'h2', 'h3']);
  });

  // ── The rail ──────────────────────────────────────────────────────────────
  it('derives merchantType in the DATABASE, so it cannot drift from the rail', async () => {
    await make({ currency: 'USDT', usdtWalletAddress: trc20() });
    expect((await getMerchant(ID)).merchantType).toBe('USDT');

    // Changing the array moves the scalar with it — there is no second write.
    await updateMerchant(ID, { accepted_currencies: ['INR'] });
    expect((await getMerchant(ID)).merchantType).toBe('INR');
  });

  it('defaults to the INR rail, so a merchant created without one is usable', async () => {
    // A merchant with no rail matches no assignment query, which is a merchant
    // that silently never receives an order.
    await make();
    const m = await getMerchant(ID);
    expect(m.acceptedCurrencies).toEqual(['INR']);
    expect(m.merchantType).toBe('INR');
  });

  it('allows a USDT merchant with no address yet — it is configured later', async () => {
    // Onboarding is two steps: the merchant exists before their wallet address
    // is confirmed. Refusing this would force an address to be invented at
    // creation, and an invented USDT address is unrecoverable money.
    const m = await createMerchant({
      merchantId: `${ID}-noaddr`, name: 'Pending address', currency: 'USDT',
    });
    expect(m.merchantType).toBe('USDT');
    expect(m.usdtWalletAddress ?? null).toBeNull();
  });

  it('refuses a merchant on two rails, or on none', async () => {
    await expect(pgQuery(
      `INSERT INTO merchants (merchant_id, name, public_ref, accepted_currencies)
       VALUES ($1, 'Both', $2, ARRAY['INR','USDT'])`, [ID, generateMerchantPublicRef()],
    )).rejects.toThrow(/merchants_one_rail/);

    await expect(pgQuery(
      `INSERT INTO merchants (merchant_id, name, public_ref, accepted_currencies)
       VALUES ($1, 'None', $2, ARRAY[]::text[])`, [`${ID}-none`, generateMerchantPublicRef()],
    )).rejects.toThrow(/merchants_one_rail/);
  });

  it('refuses a malformed TRC-20 address — USDT sent to one is unrecoverable', async () => {
    // An ERC-20 address, a truncated paste, and a lowercase 't' are all
    // rejected. Base58 is case-sensitive, so this is not a cosmetic check.
    const valid = trc20();
    for (const [i, bad] of ['0x1234', valid.slice(0, -1), valid.replace(/^T/, 't')].entries()) {
      await expect(createMerchant({
        merchantId: `${ID}-bad${i}`, name: 'Bad', currency: 'USDT', usdtWalletAddress: bad,
      })).rejects.toThrow(/merchants_usdt_address_format/);
    }
    const good = await createMerchant({
      merchantId: `${ID}-ok`, name: 'Good', currency: 'USDT', usdtWalletAddress: valid,
    });
    expect(good.usdtWalletAddress).toBe(valid);
  });

  // ── Payment credentials are an identity ───────────────────────────────────
  it('refuses two merchants sharing a UPI id, a bank account, or a USDT address', async () => {
    const upi = `pay${RUN}${seq}@bank`;
    await make({ bankDetails: { upiId: upi, accountNo: `AC${RUN}${seq}`, ifsc: 'HDFC0001' } });

    // Money routed to one would arrive at the other, and nothing afterwards
    // could say which was intended.
    await expect(createMerchant({
      merchantId: `${ID}-b`, name: 'B', bankDetails: { upiId: upi },
    })).rejects.toThrow(/merchants_upi_unique/);

    await expect(createMerchant({
      merchantId: `${ID}-c`, name: 'C',
      bankDetails: { accountNo: `AC${RUN}${seq}`, ifsc: 'HDFC0001' },
    })).rejects.toThrow(/merchants_bank_account_unique/);

    // …but two merchants with NO credentials on a rail are fine. A partial
    // index, not a plain unique one, or the second merchant with no UPI id
    // would collide with the first.
    await createMerchant({ merchantId: `${ID}-d`, name: 'D' });
    await createMerchant({ merchantId: `${ID}-e`, name: 'E' });
    expect((await getMerchant(`${ID}-e`)).name).toBe('E');
  });

  it('refuses two merchants on one mobile — a login that resolves to two accounts', async () => {
    const mobile = `97${RUN}${seq}`;
    await make({ mobile });
    await expect(createMerchant({ merchantId: `${ID}-b`, name: 'B', mobile }))
      .rejects.toThrow(/merchants_mobile_unique/);
  });

  // ── Limits, in paise ──────────────────────────────────────────────────────
  it('stores limits as integer paise and reports them in rupees', async () => {
    await make({ limits: { minDeposit: 100.5, maxDeposit: 25000, minWithdraw: 200, maxWithdraw: 30000 } });
    const m = await getMerchant(ID);
    expect(m.limits).toEqual({ minDeposit: 100.5, maxDeposit: 25000, minWithdraw: 200, maxWithdraw: 30000 });

    const { rows } = await pgQuery(
      'SELECT min_deposit_paise FROM merchants WHERE merchant_id = $1', [ID],
    );
    expect(Number(rows[0].min_deposit_paise)).toBe(10050);
  });

  it('refuses a limit range that excludes every amount', async () => {
    await expect(createMerchant({
      merchantId: ID, name: 'Backwards', limits: { minDeposit: 5000, maxDeposit: 100 },
    })).rejects.toThrow(/merchants_limits_ordered/);
  });

  // ── Assignment ────────────────────────────────────────────────────────────
  it('offers only merchants that can actually take the order', async () => {
    const base = { name: 'Cand', status: 'ACTIVE' };
    const mk = async (suffix, over) => {
      const id = `${ID}-${suffix}`;
      await createMerchant({ merchantId: id, ...base, ...over });
      await approveMerchant(id);
      await updateMerchant(id, { is_online: true, ...(over.after || {}) });
      return id;
    };
    const ok       = await mk('ok', {});
    const offline  = await mk('off', { after: { is_online: false } });
    const noDep    = await mk('nodep', { after: { accepts_deposits: false } });
    const usdt     = await mk('usdt', { currency: 'USDT', usdtWalletAddress: trc20() });
    const pending  = `${ID}-pending`;
    await createMerchant({ merchantId: pending, ...base });   // never approved

    const inr = (await listAssignableMerchants({ currency: 'INR', direction: 'DEPOSIT' }))
      .map((m) => m.merchantId);
    expect(inr).toContain(ok);
    expect(inr).not.toContain(offline);
    expect(inr).not.toContain(noDep);
    expect(inr).not.toContain(usdt);
    expect(inr).not.toContain(pending);

    expect((await listAssignableMerchants({ currency: 'USDT' })).map((m) => m.merchantId))
      .toContain(usdt);
  });

  it('DERIVES the active order count from rows, never from an accumulator', async () => {
    // The document store incremented on assign and decremented on finish, so a
    // crash between the two throttled the merchant permanently — and nothing
    // else knew the true number, so no repair was possible.
    await make();
    const order = async (state, type) => pgQuery(
      `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state, token_amount_paise)
       VALUES ($1, 'u1', $2, $3, $4, 10000)`,
      [`o-${RUN}-${seq}-${Math.random().toString(36).slice(2, 8)}`, ID, type, state],
    );
    await order('ASSIGNED', 'DEPOSIT');
    await order('PROCESSING', 'DEPOSIT');
    await order('PAID', 'WITHDRAWAL');
    await order('COMPLETED', 'DEPOSIT');   // finished — not active
    await order('CANCELLED', 'DEPOSIT');   // finished — not active

    const counts = await getActiveOrderCounts([ID]);
    expect(counts.get(ID)).toEqual({ total: 3, deposit: 2, withdrawal: 1 });

    // A merchant with no orders is present with zeros rather than missing: a
    // caller scoring candidates must not have to distinguish the two.
    expect((await getActiveOrderCounts(['nobody'])).get('nobody'))
      .toEqual({ total: 0, deposit: 0, withdrawal: 0 });
  });

  // ── Counters ──────────────────────────────────────────────────────────────
  it('records a completed order with the arithmetic in the statement', async () => {
    await make();
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 1000, earningsRupees: 20 });
    await recordCompletedOrder(ID, { direction: 'WITHDRAWAL', amountRupees: 500, earningsRupees: 10 });

    const m = await getMerchant(ID);
    expect(m.totalOrdersAll).toBe(2);
    expect(m.totalOrdersCompleted).toBe(2);
    expect(m.totalProcessedVolume).toBe(1500);
    expect(m.earnings).toBe(30);
    expect(m.totalDepositsProcessed).toBe(1);
    expect(m.totalWithdrawalsProcessed).toBe(1);
    expect(m.totalDepositAmount).toBe(1000);
    expect(m.totalWithdrawalAmount).toBe(500);
  });

  it('keeps success_rate describing the same orders total_orders_all counts', async () => {
    await make();
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 100 });
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 100 });
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 100, disputed: true });

    const m = await getMerchant(ID);
    expect(m.totalOrdersAll).toBe(3);
    expect(m.totalOrdersCompleted).toBe(2);
    expect(m.successRate).toBeCloseTo(2 / 3, 6);
    expect(m.disputeRate).toBeCloseTo(1 / 3, 6);
  });

  it('leaves the response average alone when an order was not measured', async () => {
    // NULL is "we did not measure this one", which is not "it took zero
    // minutes" — averaging a zero in would drag the merchant's score down for
    // an order that has no measurement at all.
    await make();
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 100, responseMinutes: 6 });
    const measured = (await getMerchant(ID)).avgResponseMinutes;
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 100, responseMinutes: null });
    expect((await getMerchant(ID)).avgResponseMinutes).toBe(measured);
  });

  it('resets a period once, however many workers wake at midnight', async () => {
    await make();
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 400 });
    expect((await getMerchant(ID)).merchantStats.dailyProcessed).toBe(400);

    // The boundary is the start of the period, exactly as a scheduled job
    // passes it: "reset unless this row was already reset since midnight".
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    await pgQuery(
      `UPDATE merchants SET stats_last_reset_at = $2 WHERE merchant_id = $1`,
      [ID, new Date(midnight.getTime() - 86_400_000)],
    );

    expect(await resetPeriodicStats(ID, { period: 'daily', notResetSince: midnight })).toBe(true);
    expect((await getMerchant(ID)).merchantStats.dailyProcessed).toBe(0);

    // The second worker's UPDATE matches no row, so a day that has already
    // started accumulating is not wiped a second time.
    await recordCompletedOrder(ID, { direction: 'DEPOSIT', amountRupees: 50 });
    expect(await resetPeriodicStats(ID, { period: 'daily', notResetSince: midnight })).toBe(false);
    expect((await getMerchant(ID)).merchantStats.dailyProcessed).toBe(50);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  it('refuses a suspension with no reason, at both layers', async () => {
    await make();
    await expect(suspendMerchant(ID, '   ')).rejects.toThrow(/requires a reason/);
    await expect(
      pgQuery(`UPDATE merchants SET status = 'SUSPENDED' WHERE merchant_id = $1`, [ID]),
    ).rejects.toThrow(/merchants_suspension_has_reason/);
  });

  it('clears the suspension reason on approval, so the row says one thing', async () => {
    await make();
    await suspendMerchant(ID, 'Chargebacks');
    expect((await getMerchant(ID)).suspensionReason).toBe('Chargebacks');

    const approved = await approveMerchant(ID, { actor: 'admin-1' });
    expect(approved.status).toBe('ACTIVE');
    expect(approved.merchantApprovalStatus).toBe('APPROVED');
    expect(approved.suspensionReason).toBeNull();
    expect(approved.merchantApprovedBy).toBe('admin-1');
  });

  it('records who rejected a merchant and why', async () => {
    await make();
    const r = await rejectMerchant(ID, 'Documents did not verify', { actor: 'admin-2' });
    expect(r.merchantApprovalStatus).toBe('REJECTED');
    expect(r.merchantRejectionReason).toBe('Documents did not verify');
    await expect(rejectMerchant(ID, '')).rejects.toThrow(/requires a reason/);
  });

  it('flips online and its timestamp in one statement', async () => {
    await make();
    expect((await getMerchant(ID)).lastOnlineToggle).toBeNull();
    const on = await setOnline(ID, true);
    expect(on.isOnline).toBe(true);
    expect(on.lastOnlineToggle).toBeInstanceOf(Date);
  });

  it('speaks the domain vocabulary, not the schema', async () => {
    // A route that has to know a column name is a route coupled to the schema,
    // and that coupling is what makes a rename a hundred-file change.
    await make();
    await updateMerchant(ID, {
      isOnline: true, panelUrl: 'https://panel.test',
      bankDetails: { upiId: `v${RUN}${seq}@bank`, ifsc: 'HDFC0009' },
      limits: { minDeposit: 250 },
    });
    const m = await getMerchant(ID);
    expect(m.isOnline).toBe(true);
    expect(m.panelUrl).toBe('https://panel.test');
    expect(m.bankDetails.upiId).toBe(`v${RUN}${seq}@bank`);
    // Rupees in, paise stored.
    expect(m.limits.minDeposit).toBe(250);
    const { rows } = await pgQuery(
      'SELECT min_deposit_paise FROM merchants WHERE merchant_id = $1', [ID]);
    expect(Number(rows[0].min_deposit_paise)).toBe(25000);
  });

  it('REFUSES to write an unknown or protected column', async () => {
    await make();
    await expect(updateMerchant(ID, { tokenBalance: 500 }))
      .rejects.toThrow(/refusing to write unknown or protected column\(s\): tokenBalance/);
    // Generated and identity columns are protected too.
    await expect(updateMerchant(ID, { merchant_type: 'USDT' })).rejects.toThrow(/refusing to write/);
    await expect(updateMerchant(ID, { public_ref: 'MDEADBEEF' })).rejects.toThrow(/refusing to write/);
  });

  it('will not delete a merchant that is working an order', async () => {
    await make();
    await pgQuery(
      `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state, token_amount_paise)
       VALUES ($1, 'u1', $2, 'DEPOSIT', 'PROCESSING', 10000)`,
      [`o-del-${RUN}-${seq}`, ID],
    );
    // Deleting the counterparty of an in-flight settlement leaves a player's
    // money committed to an account that no longer exists.
    expect(await deleteMerchant(ID)).toEqual({ ok: false, reason: 'HAS_OPEN_ORDERS' });

    await pgQuery(`UPDATE order_states SET state = 'COMPLETED' WHERE order_id = $1`,
      [`o-del-${RUN}-${seq}`]);
    expect(await deleteMerchant(ID)).toEqual({ ok: true });
    expect(await getMerchant(ID)).toBeNull();
    expect(await deleteMerchant(ID)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('creates a merchant and its wallet row together, or neither', async () => {
    // A merchant with no wallet row is EXCLUDED from assignment, so a
    // half-created merchant is not a merchant.
    const m = await createMerchantWithWallet({ merchantId: ID, name: 'Atomic' });
    expect(m.merchantId).toBe(ID);
    const { rows } = await pgQuery(
      'SELECT merchant_id FROM merchant_wallets WHERE merchant_id = $1', [ID],
    );
    expect(rows).toHaveLength(1);

    await expect(createMerchantWithWallet({ merchantId: ID, name: 'Duplicate' })).rejects.toThrow();
  });

  // ── Listing ───────────────────────────────────────────────────────────────
  it('pages by keyset, so a merchant created mid-listing does not hide one', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createMerchant({ merchantId: `${ID}-p${i}`, name: `Page ${i}`, status: 'ACTIVE' });
    }
    const first = await listMerchants({ search: `Page`, limit: 2 });
    expect(first.merchants).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listMerchants({ search: `Page`, limit: 2, cursor: first.nextCursor });
    const ids = new Set([...first.merchants, ...second.merchants].map((m) => m.merchantId));
    expect(ids.size).toBe(4);   // no overlap between the pages
  });

  it('counts by status in one pass', async () => {
    await make();
    const counts = await merchantCounts();
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.active).toBeGreaterThan(0);
    expect(counts.inr + counts.usdt).toBe(counts.total);
  });
});

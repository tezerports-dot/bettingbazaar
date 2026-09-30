// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * F-015 — a deposit that cannot be credited must reach somebody.
 *
 * The defect was not that money moved wrongly; it was that nothing was told.
 * `moveDepositMoney` returned `{ ok: false, reason: 'merchant_insufficient' }`,
 * both call sites answered 400, and the player — who had ALREADY SENT REAL
 * MONEY, since `PAID` is what that state means — saw an order that simply
 * stopped while the platform learned nothing.
 *
 * So what is pinned here is the REPORTING, and specifically the properties that
 * a happy-path test would never look at: that the refusal is still returned
 * unchanged, that reporting cannot turn a clean 400 into a 500, and that the
 * player's message does not name the merchant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendAlert = vi.fn(() => Promise.resolve());
const notify    = vi.fn(() => Promise.resolve([{ channel: 'IN_APP', delivered: true }]));

vi.mock('../../services/alerting.service.js', () => ({ sendAlert }));
vi.mock('../../domains/communication/communication.service.js', () => ({ notify }));

const { moveDepositMoney } = await import('../../domains/payment/depositCredit.js');

/** An order shaped the way the lifecycle hands one over at confirmation. */
const paidOrder = () => ({
  orderId: 'DEP_abc123', userId: 'u-77', merchantId: 'm-9',
  tokenAmount: 10_000, depositAllocation: 9_000, reserveAllocation: 1_000,
});

/** Movers whose merchant debit refuses, which is the whole scenario. */
const refusingMovers = () => ({
  debitMerchantTokens: vi.fn(() => Promise.resolve({ merchant: null })),
  creditDeposit: vi.fn(), creditReserve: vi.fn(), releaseUTR: vi.fn(),
});

describe('a paid deposit that cannot be credited', () => {
  beforeEach(() => { sendAlert.mockClear(); notify.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('still refuses, and credits nobody', async () => {
    // The money behaviour must be exactly what it was. Reporting is added
    // beside the refusal, never in place of it.
    const movers = refusingMovers();
    const result = await moveDepositMoney(paidOrder(), movers);

    expect(result).toMatchObject({ ok: false, reason: 'merchant_insufficient' });
    expect(movers.creditDeposit).not.toHaveBeenCalled();
    expect(movers.creditReserve).not.toHaveBeenCalled();
    // The UTR stays claimed: releasing it would let the same payment be
    // presented against a second order while this one is still live (§27).
    expect(movers.releaseUTR).not.toHaveBeenCalled();
  });

  it('alerts the operator, keyed per MERCHANT', async () => {
    await moveDepositMoney(paidOrder(), refusingMovers());

    expect(sendAlert).toHaveBeenCalledOnce();
    const [key, title, details] = sendAlert.mock.calls[0];
    // sendAlert holds a 10-minute cooldown per key. A global key would swallow
    // a SECOND merchant running dry; a per-order key would defeat the cooldown
    // and page on every retry. One merchant short is one incident.
    expect(key).toBe('deposit-uncreditable-m-9');
    expect(key).not.toContain('DEP_abc123');
    expect(title).toMatch(/cannot be credited/i);
    expect(details).toMatchObject({ merchantId: 'm-9', orderId: 'DEP_abc123' });
  });

  it('logs as well as alerting, because alerting is allowed to be a no-op', async () => {
    // sendAlert returns silently when no webhook is configured — by design. A
    // deployment without one must still leave the operator a record, or this
    // whole fix is conditional on a setting nobody may have set.
    await moveDepositMoney(paidOrder(), refusingMovers());
    expect(console.error).toHaveBeenCalled();
    expect(console.error.mock.calls.flat().join(' ')).toContain('DEP_abc123');
  });

  it('tells the player, without telling them who they paid', async () => {
    await moveDepositMoney(paidOrder(), refusingMovers());

    expect(notify).toHaveBeenCalledOnce();
    const [{ userId, message, title, relatedId }] = notify.mock.calls[0];
    expect(userId).toBe('u-77');
    expect(relatedId).toBe('DEP_abc123');
    expect(title).toBeTruthy();

    // §24 points BOTH ways: a player sees where to pay and nothing about who
    // they are paying. A "the merchant is out of tokens" message would leak the
    // counterparty's state and invite the player to think their money is gone.
    expect(message).not.toMatch(/merchant/i);
    expect(message).not.toContain('m-9');
    expect(message).not.toMatch(/token|inventory|insufficient|balance/i);
    // And it must point at the recourse that actually exists — expireOrders
    // deliberately skips PAID, so a dispute is the only route out.
    expect(message).toMatch(/dispute/i);
  });

  it('a reporting failure does not become the caller\'s failure', async () => {
    // This runs on the money path immediately before a refusal the caller must
    // still return. If reporting could throw, a clean 400 would become a 500
    // and the reason the caller branches on would be lost — reporting a problem
    // must never create a worse one.
    notify.mockRejectedValueOnce(new Error('notification store is down'));
    sendAlert.mockImplementationOnce(() => { throw new Error('webhook exploded'); });

    const result = await moveDepositMoney(paidOrder(), refusingMovers());
    expect(result).toMatchObject({ ok: false, reason: 'merchant_insufficient' });
  });

  it('reports NOTHING when the debit succeeds', async () => {
    // The mirror. An alert on a healthy deposit is worse than no alert: it
    // trains whoever reads them to ignore the channel.
    const movers = {
      debitMerchantTokens: vi.fn(() => Promise.resolve({ merchant: { merchantId: 'm-9' } })),
      creditDeposit: vi.fn(), creditReserve: vi.fn(), releaseUTR: vi.fn(),
    };
    const result = await moveDepositMoney(paidOrder(), movers);

    expect(result.ok).toBe(true);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

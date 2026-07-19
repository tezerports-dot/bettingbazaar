// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Funding Platform (BBEPS Phase 009).
//
// THE ONLY entry point for money entering or leaving the ecosystem
// (docs/governance/04-GOVERNANCE.md §1). Routes call requestDeposit/requestWithdrawal;
// nothing outside this platform calls a provider (or the P2P order
// machinery) directly for money movement.
//
// WHAT THIS PLATFORM DOES NOT OWN:
//   - Accounting: the Revenue & Settlement Platform derives ledger entries
//     from completed orders — the Funding Platform never writes accounting
//     logic (2026-07-09 directive: "integrates with Revenue & Settlement but
//     never owns accounting logic").
//   - Wallet balances: walletAuthority.service.js / merchantWallet.service.js.
//   - Configurable rules: Business Policy Platform.
//
// Every request flows: risk/validation gate (Risk Platform, Phase 010 —
// wired there) → provider adapter → funding event published on the bus.

import { publish, EVENTS } from '../../services/eventBus.service.js';
import { getProvider, listProviders, DEFAULT_PROVIDER } from './providerRegistry.js';

/**
 * requestDeposit — user wants tokens (money IN).
 * An "intent-based deposit": the returned order is an intent that a
 * provider (merchant P2P today, gateway/crypto later) fulfils and verifies.
 */
export async function requestDeposit({ userId, tokenAmount, provider = DEFAULT_PROVIDER }) {
  const adapter = getProvider(provider);
  if (!adapter.active) throw Object.assign(new Error(`Funding provider ${adapter.label} is not active.`), { status: 503 });
  if (!adapter.capabilities.deposit) throw Object.assign(new Error(`${adapter.label} does not support deposits.`), { status: 400 });

  const result = await adapter.createDeposit({ userId, tokenAmount });

  // Funding event — non-blocking, consumers must never affect the money flow.
  try {
    publish(EVENTS.PAYMENT_ORDER_CREATED, {
      orderId: result?.order?._id, userId, tokenAmount,
      type: 'DEPOSIT', provider: adapter.code,
    });
  } catch (e) { console.warn('[funding] event publish failed (non-critical):', e.message); }

  return result;
}

/** requestWithdrawal — user cashes out (money OUT). */
export async function requestWithdrawal({ userId, tokenAmount, provider = DEFAULT_PROVIDER }) {
  const adapter = getProvider(provider);
  if (!adapter.active) throw Object.assign(new Error(`Funding provider ${adapter.label} is not active.`), { status: 503 });
  if (!adapter.capabilities.withdrawal) throw Object.assign(new Error(`${adapter.label} does not support withdrawals.`), { status: 400 });

  const result = await adapter.createWithdrawal({ userId, tokenAmount });

  try {
    publish(EVENTS.PAYMENT_ORDER_CREATED, {
      orderId: result?.order?._id, userId, tokenAmount,
      type: 'WITHDRAWAL', provider: adapter.code,
    });
  } catch (e) { console.warn('[funding] event publish failed (non-critical):', e.message); }

  return result;
}

export { listProviders };

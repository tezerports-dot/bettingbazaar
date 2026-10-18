// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Funding Platform (BBEPS Phase 009).
//
// FUNDING PROVIDER REGISTRY — the Provider/Adapter pattern confirmed in the
// Phase 005 technology strategy. Every way money can enter or leave the
// ecosystem is a PROVIDER behind one interface. Adding a payment gateway or
// a crypto rail = add an adapter here; no route or service changes.
//
// Adapter interface (duck-typed; ACTIVE adapters must implement both create
// methods or declare the capability false):
//   {
//     code, label, currency, kind: 'P2P' | 'GATEWAY' | 'CRYPTO',
//     active: boolean,
//     capabilities: { deposit: boolean, withdrawal: boolean },
//     createDeposit({ userId, tokenAmount })    → provider-specific result
//     createWithdrawal({ userId, tokenAmount }) → provider-specific result
//   }

import { createDepositOrder, createWithdrawalOrder } from '../payment/paymentProcessing.service.js';

// ── MANUAL_P2P_INR — the live provider ───────────────────────────────────────
// The existing merchant-fulfilled INR flow (queue assignment, UPI/bank, UTR
// verification). The implementation stays in domains/payment/ — this adapter
// is the Funding Platform's handle on it.
const manualP2PInr = {
  code: 'MANUAL_P2P_INR',
  label: 'Merchant P2P (INR)',
  currency: 'INR',
  kind: 'P2P',
  active: true,
  capabilities: { deposit: true, withdrawal: true },
  createDeposit:    ({ userId, tokenAmount }) => createDepositOrder(userId, tokenAmount),
  createWithdrawal: ({ userId, tokenAmount }) => createWithdrawalOrder(userId, tokenAmount),
};

// ── USDT — paid to the platform on BNB Smart Chain, deposit only ──────────
//
// No merchant and no payment processor (owner, 2026-10-18). The order gets an
// address derived for it alone; the player sends USDT there and the chain
// watcher credits the order when the full amount arrives
// (`payment/usdtDeposit.service.js`). No transaction hash is asked for.
//
// So this adapter delegates to `createDepositOrder` like the INR one; the
// CURRENCY on the order is what sends it to the platform's address.
//
// Deposit-only, per the 2026-07 direction: a player buys tokens with USDT and
// never sells back into it. `capabilities.withdrawal` is false AND the method
// throws, so the rule is a property of the adapter rather than something every
// caller has to remember.
const usdt = {
  code: 'USDT',
  label: 'USDT (BNB Smart Chain)',
  currency: 'USDT',
  kind: 'P2P',
  active: true,
  capabilities: { deposit: true, withdrawal: false },
  // Priced in USDT (Step 2d): the tokens follow from the admin's rate.
  createDeposit:    ({ userId, usdtChain, usdtAmount }) =>
    createDepositOrder(userId, null, { currency: 'USDT', usdtChain, usdtAmount }),
  createWithdrawal: () => {
    throw Object.assign(
      new Error('USDT withdrawals are not supported. Withdraw in INR.'),
      { status: 400, code: 'USDT_WITHDRAWAL_UNSUPPORTED' },
    );
  },
};

// ── PAYMENT_GATEWAY — declared, inactive ─────────────────────────────────────
// Third-party gateway scaffolding (PaymentGatewayConfig model exists,
// confirmed intentional). An actual gateway integration implements this
// adapter's methods against the gateway API.
const paymentGateway = {
  code: 'PAYMENT_GATEWAY',
  label: 'Payment Gateway (future)',
  currency: 'INR',
  kind: 'GATEWAY',
  active: false,
  capabilities: { deposit: true, withdrawal: true },
  createDeposit:    () => { throw Object.assign(new Error('No payment gateway is configured.'), { status: 503 }); },
  createWithdrawal: () => { throw Object.assign(new Error('No payment gateway is configured.'), { status: 503 }); },
};

const PROVIDERS = Object.freeze({
  [manualP2PInr.code]: manualP2PInr,
  [usdt.code]: usdt,
  [paymentGateway.code]: paymentGateway,
});

export const DEFAULT_PROVIDER = manualP2PInr.code;

export function getProvider(code = DEFAULT_PROVIDER) {
  const p = PROVIDERS[code];
  if (!p) throw Object.assign(new Error(`Unknown funding provider '${code}'.`), { status: 400 });
  return p;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(({ code, label, currency, kind, active, capabilities }) =>
    ({ code, label, currency, kind, active, capabilities }));
}

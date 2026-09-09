// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { createUsdtDeposit } from './usdtDeposit.service.js';
import { btcpayConfigured } from '../../config/btcpay.config.js';

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

// ── USDT — live when BTCPay is configured ────────────────────────────────────
//
// Deposit-only, per the 2026-07 direction: a player buys tokens with USDT and
// never sells back into it. `capabilities.withdrawal` is false and the method
// throws, so the "deposit-only" rule is a property of the adapter rather than
// something every caller has to remember.
//
// `active` is DERIVED from whether the credentials exist, not written as a
// literal. Editing a boolean to switch a rail on is how a deployment ends up
// with an active adapter and no server to talk to: a player opens an invoice
// that no BTCPay ever heard of, pays nothing, and waits. Configured or absent
// is a fact about the environment, so it is read from the environment.
//
// The chain and token are BTCPay's business. The store decides which payment
// methods can settle an invoice; this platform asks for an amount in
// `BTCPAY_INVOICE_CURRENCY` and is told whether it was paid. Naming a chain
// here would be a second declaration of something only the store can enforce.
const usdt = {
  code: 'USDT',
  label: 'USDT (BTCPay Server)',
  currency: 'USDT',
  kind: 'CRYPTO',
  get active() { return btcpayConfigured(); },
  capabilities: { deposit: true, withdrawal: false },
  createDeposit:    ({ userId, tokenAmount }) => createUsdtDeposit(userId, tokenAmount),
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

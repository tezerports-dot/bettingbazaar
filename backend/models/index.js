// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * models/index.js — Barrel export for all Mongoose models.
 *
 * IMPORT ORDER matters: schemas with cross-ref dependencies must be
 * registered before the schemas that reference them. User must be first.
 *
 * Import pattern: import { User } from '../models/index.js';
 * Dynamic access:  mongoose.model('User')  — works after this barrel is loaded.
 */
// Global Mongoose options (Mongoose 9 requires updatePipeline for pipeline
// updates) — must load before any model runs a query. Imported here so every
// consumer of a model, in the app or a test, gets it for free.
import '../startup/mongooseGlobalOptions.js';
export * from '../domains/user/user.model.js';
// Markets Platform (BBEPS Phase 011) — formerly domains/game + domains/betting
export * from '../domains/markets/cycle.model.js';
export * from '../domains/markets/bet.model.js';
export * from './transaction.model.js';
export * from '../domains/merchant/merchant.model.js';
// Merchant Platform (BBEPS Phase 008) — merchant wallet audit ledger
export * from '../domains/merchant/merchantWallet.model.js';
export * from '../domains/merchant/merchantAdminTokenOrder.model.js';
export * from '../domains/payment/paymentOrder.model.js';
export * from './audit.model.js';
export * from '../domains/configuration/depositPolicy.model.js';
export * from '../domains/configuration/merchantBonusPolicy.model.js';
// Revenue & Settlement Platform (BBEPS Phase 007) — the settlement ledger
export * from '../domains/revenue/accountingEvent.model.js';
export * from '../domains/cms/content.model.js';
// App-asset metadata (PWA icons/logos) — S3-or-disk storage record
export * from '../domains/cms/appAsset.model.js';
export * from '../domains/notification/notification.model.js';
export * from './payment.model.js';
export * from './gamification.model.js';
// Casino Platform (BBEPS Phase 011) — formerly models/gameProvider.model.js
export * from '../domains/casino/gameProvider.model.js';
// Game Registry (Game Management, 2026-07-11) — catalogue metadata + categories
export * from '../domains/gameRegistry/game.model.js';
export * from '../domains/wallet/wallet.model.js';
export * from './social.model.js';
// Telegram-based player identity (bot + channel), the Aadhaar KYC record it
// feeds, and the referral programme keyed on joining order.
export * from '../domains/identity/kycVerification.model.js';
export * from '../domains/referral/referral.model.js';
// UTR global uniqueness registry — Section 9 of Migration Spec
export * from './utrRegistry.model.js';

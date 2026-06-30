// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * models/index.js — Barrel export for all Mongoose models.
 *
 * IMPORT ORDER matters: schemas with cross-ref dependencies must be
 * registered before the schemas that reference them. User must be first.
 *
 * Import pattern: import { User } from '../models/index.js';
 * Dynamic access:  mongoose.model('User')  — works after this barrel is loaded.
 */
export * from './user.model.js';
export * from './cycle.model.js';
export * from './bet.model.js';
export * from './transaction.model.js';
export * from './merchant.model.js';
export * from './paymentOrder.model.js';
export * from './audit.model.js';
export * from './auth.model.js';
export * from './systemConfig.model.js';
export * from './content.model.js';
export * from './notification.model.js';
export * from './payment.model.js';
export * from './referral.model.js';
export * from './gamification.model.js';
export * from './vip.model.js';
export * from './gameProvider.model.js';
export * from './wallet.model.js';
export * from './social.model.js';
export * from './accountRecovery.model.js';
// UTR global uniqueness registry — Section 9 of Migration Spec
export * from './utrRegistry.model.js';

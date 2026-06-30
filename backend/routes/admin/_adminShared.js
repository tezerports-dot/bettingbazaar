// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/admin/_adminShared.js
 * Shared middleware and helpers imported by all admin sub-routers.
 * Never import route files here (would create circular dependencies).
 */
import express      from 'express';
import mongoose     from 'mongoose';
import { authenticate, isAdmin, isAdminOrSubAdmin, hasPermission } from '../../middleware/auth.middleware.js';

export { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, hasPermission };

export const isAdminOrSubAdminOrQueueManager = (req, res, next) => {
  if (!req.user || (!req.user.isAdmin && !req.user.isSubAdmin && !req.user.isQueueManager)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
};

/** Lazy model getter — never call mongoose.model() at module top level */
export const getModels = () => ({
  User:             mongoose.model('User'),
  Transaction:      mongoose.model('Transaction'),
  Bet:              mongoose.model('Bet'),
  Cycle:            mongoose.model('Cycle'),
  PaymentOrder:         mongoose.model('PaymentOrder'),
  Merchant:         mongoose.model('Merchant'),
  PromoContent:     mongoose.model('PromoContent'),
  SystemConfig:     mongoose.model('SystemConfig'),
  EnhancedAuditLog: mongoose.model('EnhancedAuditLog'),
  // Dispute model removed — see GOVERNANCE.md C-1 (PaymentOrder embedded fields)
  TokenRates:       mongoose.model('TokenRates'),
  Branding:         mongoose.model('Branding'),
});

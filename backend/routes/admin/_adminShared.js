// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/admin/_adminShared.js
 * Shared middleware imported by all admin sub-routers.
 * Never import route files here (would create circular dependencies).
 *
 * ── `getModels()` is gone ───────────────────────────────────────────────────
 * It handed out ten document-store model handles, and every admin route reached
 * through it to write its own queries. There is one data layer now and it is
 * imported directly:
 *
 *     import { db } from '#db';
 *     const user = await db.users.getUser(userId);
 *
 * A shim here that returned repository-backed lookalikes would have kept those
 * call sites working and left the platform with a document-store API over a
 * relational store — the accommodation this migration exists to remove. The
 * routes changed instead.
 */
import express from 'express';
import { authenticate, isAdmin, isAdminOrSubAdmin, hasPermission } from '../../domains/identity/auth.middleware.js';

export { express, authenticate, isAdmin, isAdminOrSubAdmin, hasPermission };

export const isAdminOrSubAdminOrQueueManager = (req, res, next) => {
  if (!req.user || (!req.user.isAdmin && !req.user.isSubAdmin && !req.user.isQueueManager)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
};

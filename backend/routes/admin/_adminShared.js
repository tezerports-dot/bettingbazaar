// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import { authenticate, isAdmin, hasPermission } from '../../domains/identity/auth.middleware.js';

export { express, authenticate, isAdmin, hasPermission };

/**
 * The payment queue: admins, queue managers, and sub-admins holding `permission`.
 *
 * Every queue route, read and write, asks this — and only this. Three of them
 * used to ask it AND then refuse any sub-admin inside the handler, so the
 * Queue Manager screen the panel offered a sub-admin holding the key failed
 * on load (2026-10-01). A role check after the gate is a second answer.
 *
 * `isAdminOrSubAdminOrQueueManager` is a TIER check, so on the three queue
 * writes (assign a queued order, reassign an order, edit the merchant pool) a
 * sub-admin holding nothing but `canModerateChatPublic` could send any
 * player's order to any merchant. The audit gate counted only the exact name
 * `isAdminOrSubAdmin` and never saw these (R6, F-042 — F-001's shape again).
 * Queue managers keep the access the role exists for; `hasPermission` alone
 * would refuse them, because it admits admins and sub-admins only.
 */
export const queueManagerOrPermission = (permission) => {
  const byPermission = hasPermission(permission);
  const gate = (req, res, next) => {
    if (req.user?.isQueueManager && !req.user?.isBlocked) return next();
    return byPermission(req, res, next);
  };
  gate.permission = permission;
  gate.queueManager = true;
  return gate;
};

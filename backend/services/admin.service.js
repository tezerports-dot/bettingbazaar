// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * ADMIN SERVICE — the operations an administrator performs on an account
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Roles, blocking, deletion, sub-admins, dashboard figures, and the audit entry
 * every one of them leaves behind.
 *
 * ── What changed, and why the shape is different ────────────────────────────
 *
 * 1. NO MORE read-modify-write. Every mutation here was `findById`, assign a
 *    few fields, `save()` — a decision made against a document read a moment
 *    earlier. Two admins blocking the same account both passed the "is it
 *    already blocked?" check and the second silently overwrote the first's
 *    reason. The guards are in the UPDATE now, so exactly one wins and the
 *    other is TOLD.
 *
 * 2. THE DASHBOARD IS COMPUTED, not counted twelve times. It issued twelve
 *    separate queries, each seeing the database at a slightly different moment,
 *    so the numbers could contradict each other — an active-user count taken
 *    after a block was applied, beside a blocked count taken before. `db.stats`
 *    gathers each panel in one pass over one snapshot.
 *
 * 3. THE AUDIT ENTRY IS NOT OPTIONAL, but it never breaks the operation it
 *    describes. `db.audit` logs its own failure rather than throwing — losing
 *    the record of a block is bad; failing the block because the record could
 *    not be written is worse.
 */
import { db } from '#db';
// Communication Platform (Phase 012): notify() is the single user-messaging path.
import { notify } from '../domains/communication/communication.service.js';
// AQ-8: hash via the password authority (argon2id).
import { hashPassword } from '../domains/identity/password.util.js';
import { getBalances } from '../domains/wallet/walletAuthority.service.js';

/** The role flags a role list implies. One place, so they cannot disagree. */
const ROLE_FLAGS = Object.freeze({
  admin: 'is_admin',
  subadmin: 'is_sub_admin',
  queue_manager: 'is_queue_manager',
  mediator: 'is_mediator',
});

class AdminService {
  // ══════════════════════════════════════════════════════════════════════════
  // USER MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Assign roles to an account.
   *
   * The roles array and the boolean flags derived from it are written in ONE
   * update, so there is no instant at which a user holds the `admin` role
   * without `is_admin` — which is the pair authorisation actually reads.
   */
  async assignRoles(userId, roles, adminId) {
    const user = await db.users.getUser(userId);
    if (!user) throw new Error('User not found');

    const patch = { roles };
    for (const [role, column] of Object.entries(ROLE_FLAGS)) {
      patch[column] = roles.includes(role);
    }
    const updated = await db.users.updateUser(userId, patch);

    await this.createAuditLog({
      performedBy: adminId,
      action: 'ROLES_ASSIGNED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: userId,
      targetName: user.username || user.mobile,
      changes: { before: { roles: user.roles || [] }, after: { roles } },
    });
    return updated;
  }

  /**
   * Block an account.
   *
   * `setBlocked` puts the "not already blocked" condition in the UPDATE, so two
   * admins acting at once produce one block with one reason, and the second is
   * told rather than silently overwriting the first.
   */
  async blockUser(userId, reason, adminId) {
    const user = await db.users.getUser(userId);
    if (!user) throw new Error('User not found');
    if (user.isBlocked) throw new Error('User is already blocked');

    const updated = await db.users.setBlocked(userId, {
      blocked: true, reason, actor: adminId,
    });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'USER_BLOCKED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: userId,
      targetName: user.username || user.mobile,
      details: { reason },
      changes: { before: { isBlocked: false }, after: { isBlocked: true, reason } },
    });

    await notify({
      userId,
      type: 'ERROR',
      title: 'Account Blocked',
      message: `Your account has been blocked. ${reason ? `Reason: ${reason}` : 'Please contact support for details.'}`,
      relatedType: 'User',
    });
    return updated;
  }

  /** Unblock an account. Clears the reason, the time and the actor together. */
  async unblockUser(userId, adminId) {
    const user = await db.users.getUser(userId);
    if (!user) throw new Error('User not found');
    if (!user.isBlocked) throw new Error('User is not blocked');

    const updated = await db.users.setBlocked(userId, { blocked: false, actor: adminId });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'USER_UNBLOCKED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: userId,
      targetName: user.username || user.mobile,
      details: { previousReason: user.blockReason },
      changes: { before: { isBlocked: true }, after: { isBlocked: false } },
    });

    await notify({
      userId,
      type: 'SUCCESS',
      title: 'Account Unblocked',
      message: 'Your account has been unblocked. You can now use all features.',
      relatedType: 'User',
    });
    return updated;
  }

  /**
   * Retire an account.
   *
   * Soft: the rows stay, because a deleted player's bets and ledger entries are
   * still part of the platform's books.
   *
   * TWO GATES, and both read the authoritative source rather than a copy:
   * open orders come from `order_states`, and the locked balance comes from the
   * WALLET. Retiring an account while money is committed against it — a stake
   * mid-cycle, a withdrawal mid-flight — leaves that lock attached to an
   * account nobody can act on, and a stored copy of the balance would let the
   * delete through while the wallet still holds it.
   */
  async deleteUser(userId, adminId) {
    const user = await db.users.getUser(userId);
    if (!user) throw new Error('User not found');

    const open = await db.orders.findOrders({
      userId, states: ['ASSIGNED', 'PROCESSING', 'PAID'], limit: 1,
    });
    if (open.total > 0) throw new Error('Cannot delete user with pending orders');

    const { lockedBalance } = await getBalances(String(userId));
    if (lockedBalance > 0) throw new Error('Cannot delete user with locked balance');

    // The activity totals are read BEFORE the mobile is rewritten, so the audit
    // entry describes the account as it was.
    const activity = await db.stats.userActivity(userId);

    await db.users.updateUser(userId, {
      is_blocked: true,
      block_reason: 'Account deleted by admin',
      blocked_by: adminId,
      blocked_at: new Date(),
      status: 'SUSPENDED',
      // The mobile is unique, and a retired account must not hold the number a
      // person may legitimately re-register with.
      mobile: `DELETED_${user.mobile}_${Date.now()}`,
    });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'USER_DELETED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: userId,
      targetName: user.username,
      details: activity,
    });
    return { success: true, message: 'User account deleted successfully' };
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * KYC MANAGEMENT — REMOVED 2026-08-25
   * ════════════════════════════════════════════════════════════════════════════
   *
   * approveKYC, rejectKYC and getKYCQueue lived here with NO CALLERS, as a third
   * implementation beside routes/admin/kyc.admin.routes.js and the bulk import.
   * They were not merely redundant:
   *
   *   - both decisions did `user.kycStatus = …; await user.save()` — the exact
   *     read-modify-write on a stale read that domains/user/kycDecision.service.js
   *     was written to eliminate, so two reviewers acting at once both passed;
   *   - approveKYC wrote the RAW Aadhaar number into an audit log, a store
   *     nothing ever deletes from;
   *   - getKYCQueue filtered on a submission timestamp the Telegram signup path
   *     never sets, so it would have returned an empty queue forever.
   *
   * The live path is decideKyc(), the only place a KYC status changes.
   */

  // ══════════════════════════════════════════════════════════════════════════
  // SUB-ADMINS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a sub-admin.
   *
   * The mobile's uniqueness is decided by the index inside `createUser`, not by
   * the lookup above it: two admins creating the same sub-admin simultaneously
   * both pass a pre-read, and only one INSERT can win.
   */
  async createSubAdmin(data, adminId) {
    const { username, mobile, password, permissions = {}, role } = data;

    const passwordHash = await hashPassword(password);
    const { user, created } = await db.users.createUser({
      userId: db.users.newUserId(),
      username, mobile, passwordHash,
      status: 'ACTIVE',
    });
    if (!created) throw new Error('User with this mobile already exists');

    const subAdmin = await db.users.updateUser(user.userId, {
      is_sub_admin: true,
      sub_admin_permissions: JSON.stringify(permissions),
      sub_admin_role: role ?? null,
      roles: ['subadmin'],
    });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'SUBADMIN_CREATED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: subAdmin.userId,
      targetName: username || mobile,
      details: { permissions, role },
    });
    return subAdmin;
  }

  async updateSubAdminPermissions(subAdminId, permissions, adminId) {
    const subAdmin = await db.users.getUser(subAdminId);
    if (!subAdmin) throw new Error('Sub-admin not found');
    if (!subAdmin.isSubAdmin) throw new Error('User is not a sub-admin');

    const updated = await db.users.updateUser(subAdminId, {
      sub_admin_permissions: JSON.stringify(permissions),
    });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'SUBADMIN_PERMISSIONS_UPDATED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: subAdminId,
      targetName: subAdmin.username || subAdmin.mobile,
      changes: {
        before: { permissions: subAdmin.subAdminPermissions },
        after: { permissions },
      },
    });
    return updated;
  }

  /** Revoke sub-admin status. The account survives; only the privilege goes. */
  async deleteSubAdmin(subAdminId, adminId) {
    const subAdmin = await db.users.getUser(subAdminId);
    if (!subAdmin) throw new Error('Sub-admin not found');
    if (!subAdmin.isSubAdmin) throw new Error('User is not a sub-admin');

    await db.users.updateUser(subAdminId, {
      is_sub_admin: false,
      sub_admin_permissions: JSON.stringify({}),
      sub_admin_role: null,
      roles: (subAdmin.roles || []).filter((r) => r !== 'subadmin'),
    });

    await this.createAuditLog({
      performedBy: adminId,
      action: 'SUBADMIN_REMOVED',
      category: 'USER_MANAGEMENT',
      targetType: 'User',
      targetId: subAdminId,
      targetName: subAdmin.username || subAdmin.mobile,
    });
    return { success: true, message: 'Sub-admin removed successfully' };
  }

  async getSubAdmins() {
    const { users } = await db.users.listUsers({ isSubAdmin: true, limit: 200 });
    return users;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD AND REPORTING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The dashboard.
   *
   * Four statements — one per subject area, each internally consistent. The
   * previous version issued twelve, and two of its figures could describe the
   * database at different instants.
   */
  async getDashboardMetrics() {
    return db.stats.dashboard();
  }

  /**
   * Money and betting activity over a window, bucketed by day.
   *
   * The bucketing happens in the query. Pulling every row back to group it in
   * JavaScript is the same work done further from the data, and it stops
   * working on the day the table is big enough for anyone to care.
   */
  async getFinancialData(startDate, endDate) {
    const [transactions, betting] = await Promise.all([
      db.stats.financialSeries({ from: startDate, to: endDate }),
      db.stats.bettingSeries({ from: startDate, to: endDate }),
    ]);
    return { transactions, betting };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUDIT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Record an administrative action.
   *
   * Never throws. Losing the record of a block is bad; failing the block
   * because the record could not be written is worse — and the caller of every
   * one of these has already done the thing being described.
   */
  async createAuditLog(logData) {
    const admin = logData.performedBy ? await db.users.getUser(logData.performedBy) : null;
    return db.audit.recordDetailed({
      ...logData,
      performedByName: admin?.username || admin?.mobile || 'Unknown',
      performedByRole: admin?.isAdmin ? 'admin' : admin?.isSubAdmin ? 'subadmin' : 'user',
    });
  }

  /**
   * Read the trail.
   *
   * Keyset pagination, not skip: an entry written while an auditor pages
   * through shifts every later row by one, and the page after it silently skips
   * an entry — in the one place where a missing row is the entire point.
   */
  async getAuditLogs(filters = {}) {
    const { performedBy, category, action, startDate, endDate, limit = 100, cursor = null } = filters;
    const { entries, nextCursor } = await db.audit.search({
      adminId: performedBy, category, action,
      since: startDate ? new Date(startDate) : null,
      until: endDate ? new Date(endDate) : null,
      detailed: true, limit, cursor,
    });
    return { logs: entries, nextCursor };
  }
}

export default new AdminService();

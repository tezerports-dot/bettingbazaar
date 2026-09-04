// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** users.admin.routes.js — User management, balance adjust, block/unblock, phantom, queue managers */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from './_adminShared.js';
import { db } from '#db';
// Cycle-type vocabulary — phantom access is scoped to one type, or BOTH.
import { CYCLE_TYPE_VALUES } from '../../domains/markets/cycleTypes.js';
import { adminAdjustment } from '../../domains/wallet/walletAuthority.service.js';
import { getUser } from '#db/repositories/users.js';
import { randomBytes } from 'node:crypto';

const router = express.Router();

/**
 * The keyset cursor, over the wire.
 *
 * Base64 of the JSON, so a client cannot construct one by guessing the shape
 * and the panel does not have to know that it is a (joinedAt, userId) pair. An
 * unparseable cursor is treated as absent rather than rejected: an admin who
 * pasted half a URL gets the first page, not a 400 they cannot act on.
 */
function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return parsed?.joinedAt && parsed?.userId ? parsed : null;
  } catch {
    return null;
  }
}


/**
 * POST /api/admin/users/:userId/adjust-balance
 *
 * The affordability check used to read `user[field]` off the account document
 * while the debit moved `wallets` — two different numbers, and the guard held
 * the one that was not going to change. It now happens inside `adminAdjustment`
 * against the locked wallet row, so what this route does is translate a signed
 * rupee amount into a CREDIT/DEBIT and render the answer.
 *
 * The balances echoed back are the ones the movement itself reported, not a
 * re-read: a re-read can pick up a later movement and attribute it to this one.
 */
router.post('/users/:userId/adjust-balance', authenticate, isAdmin, async (req, res) => {
  try {
    const { amount, reason, walletType } = req.body;
    const userId = req.params.userId;
    if (!Number.isFinite(Number(amount)) || Number(amount) === 0) {
      return res.status(400).json({ success: false, message: 'amount must be a non-zero number' });
    }
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const field = (walletType === 'winnings' || walletType === 'winningsBalance')
      ? 'winningsBalance' : 'depositBalance';
    const type = Number(amount) >= 0 ? 'CREDIT' : 'DEBIT';

    const result = await adminAdjustment(
      req.user.userId, userId, type, field, Math.abs(Number(amount)),
      reason || 'Admin adjustment', randomBytes(12).toString('hex'),
    );
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: `Insufficient ${field}: have ₹${result.availableRupees}`,
      });
    }

    const newBalance = {
      depositBalance:  result.balances?.depositBalance  ?? 0,
      winningsBalance: result.balances?.winningsBalance ?? 0,
    };
    if (global.io) {
      global.io.to(`user-${userId}`).emit('user_update', { ...newBalance, server_ts: Date.now() });
      global.io.to('admin-room').emit('admin_stats_delta', { type: 'BALANCE_ADJUSTED', server_ts: Date.now() });
    }
    res.json({ success: true, newBalance, adjustment: result.adjustment });
  } catch (error) {
    console.error('Adjust balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to adjust balance' });
  }
});
router.get('/users', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { status, kycStatus, search, page = 1, limit = 50, cursor } = req.query;

    // Merchants are a completely separate entity with their own record and auth
    // system, so the player list excludes them by the role they were created
    // with. Admins and sub-admins stay visible: an operator looking for an
    // account by name needs to find one whatever its flags say.
    //
    // The search is an ANCHORED prefix match inside the repository, not a
    // regex. The filter this replaced built `{ $regex: escaped, $options: 'i' }`
    // — escaped against ReDoS, but still a full collection scan with a leading
    // wildcard on every keystroke of an admin's search box.
    const listed = await db.users.listUsers({
      status: status && status !== 'all' ? status : null,
      kycStatus: kycStatus && kycStatus !== 'all' ? kycStatus : null,
      search: search || null,
      excludeRole: 'merchant',
      limit: Math.min(Number(limit) || 50, 200),
      cursor: parseCursor(cursor),
      page: cursor ? null : page,
    });

    res.json({
      success: true,
      users: listed.users,
      // The cursor is what the next page should actually be fetched with: a
      // signup arriving mid-pagination shifts every offset page by one and
      // silently skips an account. Page numbers stay in the response for the
      // panel that still draws them.
      nextCursor: listed.nextCursor ? encodeCursor(listed.nextCursor) : null,
      pagination: {
        total: listed.total,
        page: Number(page) || 1,
        limit: Math.min(Number(limit) || 50, 200),
        pages: Math.max(Math.ceil(listed.total / Math.min(Number(limit) || 50, 200)), 1),
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

// Get single user
router.get('/users/:userId', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const user = await db.users.getUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Bets and wallet movement, from the tables that hold them. The two reads
    // this replaced queried by `user._id` — a field the repository's user
    // objects do not have — so `undefined` matched nothing and every admin
    // profile showed an empty activity list for every player on the platform.
    const [recentBets, ledger, activity] = await Promise.all([
      db.bets.listUserBets(user.userId, { limit: 10 }),
      db.wallets.getUserLedger(user.userId, 1, 10),
      db.stats.userActivity(user.userId),
    ]);

    res.json({
      success: true,
      user,
      recentBets,
      recentTransactions: ledger.entries,
      activity,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
});

/**
 * Set an account's roles.
 *
 * The authorisation flags are DERIVED from the roles inside one statement, not
 * assigned beside them. The handler this replaced set `roles`, then `isAdmin`,
 * `isSubAdmin` and `isQueueManager` as four properties on a document and saved
 * it — and it called `.save()` on a plain object the repository returned, which
 * is a TypeError, so this endpoint has thrown on every call since the accounts
 * moved to PostgreSQL.
 */
router.put('/users/:userId/roles', authenticate, isAdmin, async (req, res) => {
  try {
    const { roles } = req.body;
    if (!Array.isArray(roles)) {
      return res.status(400).json({ success: false, message: 'roles must be an array' });
    }
    const KNOWN = ['admin', 'subadmin', 'queue_manager', 'merchant', 'mediator'];
    const unknown = roles.filter((r) => !KNOWN.includes(r));
    if (unknown.length) {
      return res.status(400).json({
        success: false, message: `Unknown role(s): ${unknown.join(', ')}`,
      });
    }

    const user = await db.users.setRoles(req.params.userId, roles);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'USER_ROLES_SET', category: 'USER',
      targetType: 'User', targetId: String(user.userId),
      details: { roles },
    });

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to update roles' });
  }
});

// Block user
router.put('/users/:userId/block', authenticate, isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    // A block REQUIRES a reason — `users_blocked_has_reason` refuses a blocked
    // row without one, and the handler this replaced passed whatever the body
    // held, so a block submitted with no reason threw a constraint violation
    // and returned a 500 the admin could not act on.
    if (!reason) {
      return res.status(400).json({ success: false, message: 'A block requires a reason' });
    }

    const user = await db.users.setBlocked(req.params.userId, {
      blocked: true, reason, actor: req.user.userId,
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // `status` is what the login path reads, and `is_blocked` is what the
    // request guards read. The old handler set both on a document; here the
    // second write is explicit so it cannot be forgotten, and both land before
    // the response says the account is blocked.
    await db.users.updateUser(user.userId, { status: 'BLOCKED' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'USER_BLOCK', category: 'USER',
      targetType: 'User', targetId: String(user.userId),
      details: { reason },
    });

    res.json({ success: true, message: 'User blocked successfully' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ success: false, message: 'Failed to block user' });
  }
});

// Unblock user — with optional warningCount reset (Section 13.4 of Migration Spec)
router.put('/users/:userId/unblock', authenticate, isAdmin, async (req, res) => {
  try {
    const { resetWarnings = false } = req.body;

    const user = await db.users.setBlocked(req.params.userId, { blocked: false });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Resetting warnings is the admin saying "this user is cleared", so the
    // explicit payment-complaint flag goes with it (owner directive 2026-07-14).
    const patch = { status: 'ACTIVE' };
    if (resetWarnings) {
      patch.warningCount = 0;
      patch.paymentFlagged = false;
      patch.paymentFlagReason = null;
      patch.paymentFlaggedAt = null;
    }
    const cleared = await db.users.updateUser(user.userId, patch);

    // The audit repository already swallows its own failures — an audit write
    // that throws logs and returns null rather than taking down the operation
    // it was describing. The bare `catch (_) {}` around this call was a second
    // layer of the same thing that also hid a MissingSchemaError: `AuditLog`
    // resolved to no schema, so every unblock on this route recorded NOTHING
    // and reported success.
    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
      action: 'USER_UNBLOCK', category: 'USER',
      targetType: 'User', targetId: String(user.userId),
      details: { resetWarnings },
    });

    res.json({
      success: true,
      message: `User unblocked${resetWarnings ? ' and warnings reset' : ''}`,
      warningCount: cleared.warningCount,
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ success: false, message: 'Failed to unblock user' });
  }
});

/**
 * Delete a user — soft, and attributed.
 *
 * Nothing is erased. The bets, orders and ledger rows stay exactly where they
 * are, because a deleted account's money still has to reconcile, and
 * `users_deleted_has_actor` means the row itself records who removed it and
 * when. The handler this replaced set those three fields on a plain object and
 * called `.save()`, so no deletion has been recorded at all.
 */
router.delete('/users/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const user = await db.users.softDeleteUser(req.params.userId, { actor: req.user.userId });
    if (!user) {
      // Null covers both "no such account" and "already deleted": either way
      // there was nothing here to delete, and reporting success for the second
      // is how a double-click looks like two deletions in an audit trail.
      return res.status(404).json({ success: false, message: 'User not found or already deleted' });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'USER_DELETED', category: 'USER',
      targetType: 'User', targetId: String(user.userId),
      details: { username: user.username },
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📋 KYC MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get KYC queue
router.get('/phantom-agents', authenticate, isAdmin, async (req, res) => {
  try {
    // Secrets never leave the repository: `toUser` omits the password hash and
    // both two-factor secrets, so the `.select('-passwordHash …')` this
    // replaced — a denylist that grants every credential column somebody adds
    // later — is not needed and cannot be forgotten.
    const agents = await db.users.listPhantomAgents();
    res.json({ success: true, agents });
  } catch (error) {
    console.error('Get phantom agents error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch phantom agents' });
  }
});

// Assign phantom agent role
router.post('/users/:userId/phantom-access', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { accessLevel } = req.body; // 'NONE', a cycle type, or 'BOTH' (= every type)

    // Derived from the type registry rather than restated. As a literal list
    // this silently rejected any newly added cycle type — the admin UI would
    // offer the option and the save would 400.
    const validLevels = ['NONE', ...CYCLE_TYPE_VALUES, 'BOTH'];
    if (!validLevels.includes(accessLevel)) {
      return res.status(400).json({
        success: false,
        message: `Invalid access level. Must be: ${validLevels.join(', ')}`
      });
    }
    
    const user = await db.users.getUser(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    user.phantomAccess = accessLevel;
    await user.save();
    
    res.json({
      success: true,
      message: `Phantom access updated to ${accessLevel}`,
      user
    });
  } catch (error) {
    console.error('Assign phantom access error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign phantom access' });
  }
});

// Get phantom betting statistics
router.get('/analytics/phantom-stats', authenticate, isAdmin, async (req, res) => {
  try {
    // Grouped in the database, ordered by when the cycle RAN. The aggregate
    // this replaced sorted on the grouped cycle id, so its "most recent 10"
    // were whichever ids sorted highest as strings.
    const phantomStats = await db.stats.phantomBetsByCycle({ limit: 10 });

    res.json({ success: true, stats: phantomStats });
  } catch (error) {
    console.error('Get phantom stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch phantom stats' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📋 QUEUE MANAGER OPERATIONS
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get all queue managers
router.get('/queue-managers', authenticate, isAdmin, async (req, res) => {
  try {
    const managers = await db.users.listQueueManagers();
    res.json({ success: true, managers });
  } catch (error) {
    console.error('Get queue managers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch queue managers' });
  }
});

// Assign queue manager role
router.post('/users/:userId/queue-manager', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { enable } = req.body; // true or false
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enable must be true or false' });
    }

    // One UPDATE. The handler this replaced read the account, set the property
    // on the plain object the repository returned and called `.save()` on it —
    // a TypeError, so no queue manager has been assignable since the accounts
    // moved to PostgreSQL.
    const user = await db.users.updateUser(userId, { isQueueManager: enable });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: enable ? 'QUEUE_MANAGER_ASSIGNED' : 'QUEUE_MANAGER_REMOVED',
      category: 'USER', targetType: 'User', targetId: String(userId),
      details: { enable },
    });

    res.json({
      success: true,
      message: enable ? 'Queue manager role assigned' : 'Queue manager role removed',
      user
    });
  } catch (error) {
    console.error('Assign queue manager error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign queue manager role' });
  }
});

// ─── GET /api/admin/payment-queue ──────────────────────────────────────────────
// Returns ALL orders grouped by status with summary stats — different from
// /queue/pending-orders which returns only PENDING orders for the assignment
// workflow. QueueDashboard "Queue Overview" tab uses this for a full snapshot.
/**
 * One player's whole history: wallet movement, bets and funding orders.
 *
 * ── Merged and paginated in the DATABASE ───────────────────────────────────
 * The handler this replaced fetched EVERY transaction, EVERY bet and EVERY
 * order for the player with no limit, concatenated the three arrays, sorted
 * them in JavaScript and sliced fifty rows out. On an active player that is
 * tens of thousands of rows across the wire to render one page, and the sort
 * ran again on every request.
 *
 * It also called `.populate('merchantId', …)` on plain rows, which is a
 * TypeError — so this endpoint threw for every player who had ever placed a
 * funding order, which is every player who has ever deposited.
 */
router.get('/users/:userId/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const timeline = await db.stats.userTimeline(userId, { page, limit });

    res.json({
      success: true,
      transactions: timeline.entries,
      pagination: {
        total: timeline.total, page: timeline.page,
        limit: timeline.limit, pages: timeline.pages,
      },
    });
  } catch (error) {
    console.error('Get user transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user transactions' });
  }
});

// Add CDN URL to library (no file upload)

export default router;

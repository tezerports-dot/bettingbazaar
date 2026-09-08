// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** users.admin.routes.js — User management, balance adjust, block/unblock, phantom, queue managers */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from './_adminShared.js';
import { db } from '#db';
// Cycle-type vocabulary — phantom access is scoped to one type, or BOTH.
import { CYCLE_TYPE_VALUES } from '../../domains/markets/cycleTypes.js';
import { adminAdjustment } from '../../domains/wallet/walletAuthority.service.js';
import { getUser } from '#db/repositories/users.js';
// The wallet rows themselves — a delete is a decision, and a decision reads
// what a movement would lock, never a stored copy of a balance.
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { randomBytes } from 'node:crypto';
// `maxWarnings` — one owner. The setting that used to auto-block on a merchant
// rejection now marks a flagged player for review; it is READ here, never
// re-declared, so editing it in System Settings changes this screen.
import { getRiskRules } from '../../domains/risk/riskValidation.service.js';

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

/**
 * GET /api/admin/users/flagged — the review queue.
 *
 * ── This route MUST stay above `/users/:userId` ─────────────────────────────
 * Express matches in declaration order, so `/users/:userId` declared first
 * swallows this path with `userId === 'flagged'` — a 404 for a player that does
 * not exist, on a screen whose empty state is indistinguishable from "nobody is
 * flagged". There is a test that fails if the two are reordered, because the
 * symptom is silent.
 *
 * ── What it answers ─────────────────────────────────────────────────────────
 * A merchant rejecting a paid order warns and flags a player but does NOT block
 * them (owner decision 2026-09-07). This is where that decision gets made, so
 * it carries what the decision needs: the merchant's stated reason, the proof
 * image they uploaded, the order, and the player's warning history.
 *
 * `overWarningThreshold` is the admin's own `maxWarnings` applied here — that
 * setting used to auto-block and now marks a player for review instead. It is
 * read from the risk rules, not duplicated, so the number an operator edits in
 * System Settings is the number this screen sorts by.
 */
router.get('/users/flagged', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const [players, rules] = await Promise.all([
      db.users.listFlaggedPlayers({ limit: Math.min(Number(req.query.limit) || 100, 200) }),
      getRiskRules(),
    ]);
    const threshold = Number(rules.maxWarnings) || 0;
    res.json({
      success: true,
      // The threshold goes out with the rows so the screen can say WHY a player
      // is marked for review, rather than showing a colour it cannot explain.
      warningThreshold: threshold,
      players: players.map((p) => ({
        ...p,
        overWarningThreshold: threshold > 0 && Number(p.warningCount || 0) >= threshold,
      })),
    });
  } catch (error) {
    console.error('Get flagged users error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch flagged players' });
  }
});

/**
 * POST /api/admin/users/:userId/clear-flag — "reviewed, no action".
 *
 * The only way to clear a payment flag was `PUT /users/:userId/unblock` with
 * `resetWarnings`, which needs the player to be blocked. Under the rule that a
 * rejection does not block, that is every flagged player — so dismissing a
 * merchant's complaint required blocking the player first, which is the exact
 * thing the rule exists to prevent.
 *
 * `resetWarnings` stays the admin's separate choice: clearing one wrong
 * complaint should not erase the record of every earlier one.
 */
router.post('/users/:userId/clear-flag', authenticate, isAdmin, async (req, res) => {
  try {
    const { resetWarnings = false, note } = req.body || {};
    const user = await db.users.clearPaymentFlag(req.params.userId, {
      resetWarnings: Boolean(resetWarnings),
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'USER_PAYMENT_FLAG_CLEARED', category: 'USER',
      targetType: 'User', targetId: String(user.userId),
      details: { resetWarnings: Boolean(resetWarnings), note: note ?? null },
    });

    res.json({
      success: true,
      message: `Flag cleared${resetWarnings ? ' and warnings reset' : ''}`,
      user,
    });
  } catch (error) {
    console.error('Clear payment flag error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear flag' });
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

    // `status` and `is_blocked` are set by `setBlocked` in ONE statement. They
    // used to be two writes from here, and they are read by different halves of
    // the platform — sign-in reads `status`, request guards read `is_blocked` —
    // so a failure between them produced an account the two halves disagreed
    // about, with nothing on any screen saying so.

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

    // `status` comes back to ACTIVE inside `setBlocked` now. It used to be a
    // second `updateUser` from here, and the pair could come apart.
    const user = await db.users.setBlocked(req.params.userId, { blocked: false });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Resetting warnings is the admin saying "this user is cleared", so the
    // explicit payment-complaint flag goes with it (owner directive 2026-07-14).
    //
    // ── This path was a 500, and it was a 500 AFTER the unblock committed ────
    // It set `paymentFlagReason = null` through `updateUser`, and the column is
    // `NOT NULL DEFAULT ''`. Every unblock-with-reset raised 23502: the admin
    // saw a failure, the account had already been unblocked by the statement
    // above, and `status` had not moved — so the player could not sign in, the
    // request guards would have admitted them, and retrying produced the same
    // 500 forever. `clearPaymentFlag` is one statement that writes `''`.
    const cleared = resetWarnings
      ? await db.users.clearPaymentFlag(user.userId, { resetWarnings: true })
      : user;

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
    // ── Money in flight refuses the delete ──────────────────────────────────
    // These two guards existed ONLY in `services/admin.service.js`, which
    // nothing imports — and `moneyDecisionsReadTheWallet.test.js` asserted the
    // locked-balance one AGAINST THAT DEAD FILE, so the suite reported the
    // guard as present while the live route had none.
    //
    // Without them: a player with a PAID deposit awaiting merchant confirmation,
    // or a withdrawal sitting in escrow, is marked DELETED while the order stays
    // live in the merchant queue. The merchant completes it and the money has no
    // owner who can sign in to see it. Nothing anywhere reports a problem —
    // `softDeleteUser` only writes status/deleted_at/deleted_by, and it succeeds.
    //
    // The order check comes first because it is the cheaper read and the more
    // common refusal.
    const open = await db.orders.findOrders({
      userId: req.params.userId,
      states: ['ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED'],
      limit: 1,
    });
    if (open.total > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete: ${open.total} order(s) still open. Resolve or cancel them first.`,
      });
    }

    // Read from the WALLET, not from a stored copy on the account row (Trap 7).
    // This is a decision read: it refuses an irreversible action, so it must see
    // the same rows a movement would lock.
    const { lockedBalance } = await getBalancesPaise(String(req.params.userId));
    if (lockedBalance > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete: ₹${(lockedBalance / 100).toLocaleString('en-IN')} is locked in escrow or an open bet.`,
      });
    }

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
    
    // ── This assigned the field and called `user.save()` ────────────────────
    // `getUser` returns a mapped row, not a document; `.save` is not a function
    // on it, so this threw a TypeError on EVERY call and the catch returned a
    // 500 having written nothing. Phantom access has never once been granted or
    // revoked through this route.
    const updated = await db.users.updateUser(userId, { phantom_access: accessLevel });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'PHANTOM_ACCESS_SET', category: 'USER',
      targetType: 'User', targetId: String(userId),
      details: { accessLevel },
    });

    res.json({
      success: true,
      message: `Phantom access updated to ${accessLevel}`,
      user: updated,
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

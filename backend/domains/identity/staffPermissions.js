// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * staffPermissions.js — THE list of what a sub-admin can be given (CLAUDE.md §2).
 *
 * Owner, 2026-10-01: *"all sub admin read routes should be permission based by
 * admin … give them permission by selecting the permissions from the entire
 * list of access and permission, the sub admin then can only do the work in
 * those permissioned areas."*
 *
 * So every area of the admin panel is one key here, and every staff route asks
 * for exactly one of them: the area it belongs to. A full admin holds all of
 * them. A sub-admin holds the ones an admin ticked. There is no third answer:
 *
 *   - no route is open to "any sub-admin" whatever they were given, and
 *   - no area is reachable only by a full admin, EXCEPT the ones in
 *     ADMIN_ONLY_AREAS below, each with the reason it cannot be delegated.
 *
 * `npm run check:staff-permissions` reads the route stacks and fails the build
 * on a staff route that asks for anything else (the class F-001 and F-042 were
 * single instances of).
 *
 * ── Why the list lives HERE and nowhere else ────────────────────────────────
 * It was a nine-key list in the admin panel (`utils/permissions.ts`) that the
 * server never read, so the two halves drifted: the chat screen was gated on
 * `canModerateChatPublic` while every chat route asked for `canManageSupport`,
 * and 136 routes asked for "full admin" behind screens the panel offered to
 * sub-admins. The panel now renders the picker from `GET
 * /api/admin/staff-permissions`; its route guards keep a §5 mirror of the KEYS,
 * which a backend test holds equal to this file.
 *
 * A key never named here can never be granted: `normaliseGrant` refuses it, so a
 * typo in a create form is a 400 naming the key, not a silent no-op that leaves
 * a colleague locked out of the screen they were promised.
 */

/** Areas, in the order the picker shows them. */
export const PERMISSION_GROUPS = Object.freeze([
  { key: 'analytics', label: 'Analytics & reports' },
  { key: 'players',   label: 'Players' },
  { key: 'merchants', label: 'Merchants' },
  { key: 'payments',  label: 'Payments & disputes' },
  { key: 'games',     label: 'Games & cycles' },
  { key: 'content',   label: 'Content & communication' },
  { key: 'platform',  label: 'Platform' },
]);

/**
 * Every grantable permission. `money: true` marks a key whose routes move money
 * or decide where it goes, so the picker can say so beside the box.
 */
export const STAFF_PERMISSIONS = Object.freeze([
  // ── Analytics & reports ──────────────────────────────────────────────────
  { key: 'canViewAnalytics', group: 'analytics', label: 'View analytics',
    description: 'Dashboard figures, Live Cycles, Cycle History, Profit & Loss, Token Flow, Revenue & Ledger, Operations and Reports.' },
  { key: 'canExportLedger', group: 'analytics', label: 'Export the ledger',
    description: 'Download the whole accounting ledger as a file: every money movement on the platform.' },
  { key: 'canViewAuditLogs', group: 'analytics', label: 'Audit and error logs',
    description: 'Read the administrative action trail, the admin activity feed and the error log, and clear the error log.' },

  // ── Players ──────────────────────────────────────────────────────────────
  { key: 'canManageUsers', group: 'players', label: 'Manage players',
    description: 'Player list and records, flagged players: block, unblock, clear a flag, delete an account.' },
  { key: 'canAdjustBalances', group: 'players', label: 'Adjust player balances', money: true,
    description: 'Credit or debit a player\'s wallet by hand, and read the adjustment history.' },
  { key: 'canVerifyKYC', group: 'players', label: 'Verify KYC',
    description: 'The KYC queue: approve or reject one player\'s Aadhaar.' },
  { key: 'canBulkVerifyKYC', group: 'players', label: 'Bulk KYC',
    description: 'Export pending Aadhaar numbers for verification and import the verdicts.' },
  { key: 'canViewTransactions', group: 'players', label: 'View transactions',
    description: 'The transaction history of every player, read only.' },
  { key: 'canManagePhantomAgents', group: 'players', label: 'Phantom agents',
    description: 'Choose who may place cosmetic bets and on which boards, and read phantom statistics.' },
  { key: 'canManageReferrals', group: 'players', label: 'Referral programme', money: true,
    description: 'Read referral statistics and pay out the referral queue.' },

  // ── Merchants ────────────────────────────────────────────────────────────
  { key: 'canManageMerchants', group: 'merchants', label: 'Manage merchants',
    description: 'Merchant list and records, approve, reject, suspend, activate, limits and capabilities, create a merchant, Merchant Platform, and the payment queue.' },
  { key: 'canFundMerchants', group: 'merchants', label: 'Top up and deduct merchant wallets', money: true,
    description: 'Move tokens between the platform and a merchant\'s wallet.' },
  { key: 'canManageMerchantTokenOrders', group: 'merchants', label: 'Merchant token purchases', money: true,
    description: 'Approve or reject a merchant buying the float they trade with.' },
  { key: 'canManageCommission', group: 'merchants', label: 'Merchant commission', money: true,
    description: 'Commission rates and their history, run the commission engine, and fund the bonus pool it pays from.' },

  // ── Payments & disputes ──────────────────────────────────────────────────
  { key: 'canResolveDisputes', group: 'payments', label: 'Resolve disputes', money: true,
    description: 'The dispute queue, CDM slips and stalled payouts, and the decision to release or refund.' },
  { key: 'canManageUtr', group: 'payments', label: 'Payment references (UTR)',
    description: 'The UTR registry: look a reference up, flag or clear it, resolve a contested one.' },
  { key: 'canManagePaymentSystem', group: 'payments', label: 'Payment system',
    description: 'Payment gateway settings and the gateway test.' },
  { key: 'canManageBusinessPolicy', group: 'payments', label: 'Business policy', money: true,
    description: 'Deposit policy (edit, approve, roll back) and the settlement rail.' },

  // ── Games & cycles ───────────────────────────────────────────────────────
  { key: 'canManageGames', group: 'games', label: 'Games and providers',
    description: 'Game registry, categories, casino / crash / sports providers and their transactions.' },
  { key: 'canManageCycles', group: 'games', label: 'Cycle controls',
    description: 'Act on a live cycle: equalise the phantom book or change its state.' },

  // ── Content & communication ──────────────────────────────────────────────
  { key: 'canManageContent', group: 'content', label: 'Content and branding',
    description: 'FAQ, page slides and promos, support links, CDN library, branding, app assets, announcements and the winners manager.' },
  { key: 'canModerateChat', group: 'content', label: 'Moderate public chat',
    description: 'Read and delete chat messages, ban and unban players from chat.' },
  { key: 'canManageSupportTickets', group: 'content', label: 'Support tickets',
    description: 'Read player support tickets and reply to them.' },
  { key: 'canManageSupportAssistant', group: 'content', label: 'Support assistant',
    description: 'The knowledge base the support assistant answers players from.' },
  { key: 'canManageTelegram', group: 'content', label: 'Telegram setup',
    description: 'Sign-in and recovery bots, channels and bot message templates, for all three panels.' },

  // ── Platform ─────────────────────────────────────────────────────────────
  { key: 'canManageSystemSettings', group: 'platform', label: 'System settings',
    description: 'Platform configuration: limits, timings and every other admin-editable business number.' },
  { key: 'canManageAndroidApp', group: 'platform', label: 'Android app',
    description: 'Upload, publish, halt and resume Android releases.' },
  { key: 'canManageIpBlocks', group: 'platform', label: 'Blocked IPs',
    description: 'Block an address or range, and lift a block.' },
  { key: 'canRunMaintenance', group: 'platform', label: 'Maintenance jobs',
    description: 'Run the retention job and rebuild the leaderboard by hand.' },
]);

/**
 * What a full admin keeps to themselves, and why. Each of these GRANTS
 * authority, so a sub-admin holding one could give themselves every key above:
 * delegating it is delegating "full admin" under another name.
 */
export const ADMIN_ONLY_AREAS = Object.freeze([
  { area: 'Sub-admins', why: 'Creating a sub-admin or changing one\'s permissions grants authority; a holder could grant themselves everything.',
    routes: ['GET /sub-admins', 'POST /sub-admins', 'PUT /sub-admins/:subAdminId/permissions', 'DELETE /sub-admins/:subAdminId', 'GET /staff-permissions'] },
  { area: 'Staff roles', why: 'Setting an account\'s roles can make it an admin.',
    routes: ['PUT /users/:userId/roles'] },
  { area: 'Queue managers', why: 'The queue-manager role routes players\' payments; granting it is granting authority.',
    routes: ['GET /queue-managers', 'POST /users/:userId/queue-manager'] },
]);

/**
 * Staff routes that ask for NO area, because they are about the caller
 * themselves: every account, of any kind, may ask whether it has passed its
 * own sign-in gate.
 */
export const SELF_ROUTES = Object.freeze(['GET /verification']);

export const PERMISSION_KEYS = Object.freeze(STAFF_PERMISSIONS.map((p) => p.key));
const KNOWN = new Set(PERMISSION_KEYS);

export const isPermissionKey = (key) => KNOWN.has(key);

const LABELS = new Map(STAFF_PERMISSIONS.map((p) => [p.key, p.label]));
/** The words the Sub-admins screen shows for a key. */
export const permissionLabel = (key) => LABELS.get(key) ?? key;

/**
 * A grant as it is stored: every catalogue key, as a boolean, and nothing else.
 *
 * Refuses an unknown key BY NAME (status 400), rather than storing it where no
 * route reads it. Accepts either `{ key: true }` or `['key', …]`, because a
 * picker naturally holds one and an API caller the other.
 */
export function normaliseGrant(input) {
  const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'UNKNOWN_PERMISSION' });
  let granted;
  if (Array.isArray(input)) {
    granted = new Set(input);
  } else if (input && typeof input === 'object') {
    granted = new Set(Object.entries(input).filter(([, v]) => v === true).map(([k]) => k));
    // A value that is not a boolean is refused, not coerced: the string "false"
    // is truthy, and coercing it switched a revoked permission back on.
    const notBoolean = Object.entries(input).filter(([, v]) => typeof v !== 'boolean').map(([k]) => k);
    if (notBoolean.length) throw refuse(`Permission values must be true or false: ${notBoolean.join(', ')}`);
    const unknownKeys = Object.keys(input).filter((k) => !KNOWN.has(k));
    if (unknownKeys.length) throw refuse(`Unknown permission: ${unknownKeys.join(', ')}`);
  } else if (input === undefined || input === null) {
    granted = new Set();
  } else {
    throw refuse('permissions must be an object of { key: true|false } or a list of keys');
  }
  const unknown = [...granted].filter((k) => !KNOWN.has(k));
  if (unknown.length) throw refuse(`Unknown permission: ${unknown.join(', ')}`);
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, granted.has(k)]));
}

/**
 * Whether this account may work in this area. The ONE answer to the question,
 * used by the HTTP middleware and by both realtime transports, so a key revoked
 * on the REST API cannot stay live on a stream (§32 S32).
 */
export function staffCan(user, key) {
  if (!user || user.isBlocked) return false;
  if (user.isAdmin === true) return true;
  if (user.isSubAdmin !== true) return false;
  return user.subAdminPermissions?.[key] === true;
}

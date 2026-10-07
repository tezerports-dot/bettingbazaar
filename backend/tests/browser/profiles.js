// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Who the browser inventory opens the panels AS — one account per profile.
 *
 * Owner, 2026-10-01: measure "every control never pressed per account type and
 * state" instead of guessing. Every browser pass opened each panel as ONE
 * account: a verified player with ₹1,500, a full admin, a cash merchant. A
 * control that only exists for somebody else — the GHOST MODE toggle a phantom
 * agent sees, the screens a sub-admin is limited to, what a suspended merchant
 * or an unverified player is shown — was never in the inventory, so it could
 * never be counted as unpressed. It was simply not there to miss.
 *
 * Each profile seeds a FRESH account through the same seed functions every
 * pass uses (§5), and only then moves it into its state through the rows the
 * platform's own code writes — never a state the platform cannot produce
 * (§32 S16). `npm run test:browser` with `BB_PROFILE=<name>` inventories that
 * panel as that account and writes `controls.manifest.<name>.json`;
 * `scripts/report-control-gaps.mjs` compares them.
 *
 * `default` is not here: it is `seedActors()` itself, the account the drive and
 * mutate passes press as unless told otherwise. `BB_PROFILE=<name> npm run
 * test:drive` presses a profile's panel AS that account, seeded by the same
 * `seedProfile` call in the same order, and writes `drive.report.<name>.json`.
 */
import { pgQuery } from '#db/client.js';
import { pauseAssignment, suspendMerchant } from '#db/repositories/merchants.js';
import { normaliseGrant, PERMISSION_KEYS } from '../../domains/identity/staffPermissions.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, trc20, bep20 } from '../e2e/seed.js';
import { playerToken, merchantToken, adminToken } from '../e2e/harness.js';

/** The admin panel caches what `/me` returned; a returning operator has it before first paint. */
const staffCache = (u, { isAdmin = false, isSubAdmin = false, isQueueManager = false, permissions = {} } = {}) => ({
  id: u.userId, _id: u.userId, userId: u.userId, username: u.username ?? u.userId, mobile: u.mobile,
  isAdmin, isSubAdmin, isQueueManager, permissions,
});
const merchantCache = (m, extra = {}) => ({
  id: m.merchantId, merchantId: m.merchantId, username: m.username, email: m.email, mobile: m.mobile,
  isOnline: true, status: 'ACTIVE', acceptedCurrencies: ['INR'], ...extra,
});

const player = (opts, then) => ({
  panel: 'user-panel',
  seed: async () => {
    const u = await seedPlayer({ balancePaise: 150000, ...opts });
    if (then) await then(u);
    return { token: playerToken(u), cached: undefined, who: u.userId };
  },
});

/** A staff account: seeded as an admin, then demoted to exactly what the profile says. */
const staff = ({ isSubAdmin = false, isQueueManager = false, keys = [] }) => ({ panel: 'admin-panel', seed: async () => {
  const u = await seedAdmin();
  const grant = normaliseGrant(Object.fromEntries(keys.map((k) => [k, true])));
  await pgQuery(
    `UPDATE users SET is_admin = FALSE, is_sub_admin = $2, is_queue_manager = $3,
                      sub_admin_permissions = $4::jsonb, roles = $5
      WHERE user_id = $1`,
    [u.userId, isSubAdmin, isQueueManager, JSON.stringify(isSubAdmin ? grant : {}),
      [isSubAdmin ? 'subadmin' : null, isQueueManager ? 'queue_manager' : null].filter(Boolean)],
    'profile_staff',
  );
  return {
    token: adminToken(u),
    cached: staffCache(u, { isSubAdmin, isQueueManager, permissions: isSubAdmin ? grant : {} }),
    who: u.userId,
  };
} });

/**
 * A merchant, and — when `rail` is named — a MEMBER of a working team on it.
 *
 * Since Step 2c a merchant holds no tokens and is on no rail by itself: the
 * rail is the team supervisor's, so "a cash merchant" is a member of a CASH
 * team. `exclusive: false`, because a profile is an account to LOOK at, and
 * taking every other team on the rail offline would change what the drive
 * pass's own merchant is routed.
 */
const merchant = (opts, then, extraCache, rail = null) => ({ panel: 'merchant-panel', seed: async () => {
  const m = await seedMerchant({ currency: 'INR', ...opts });
  if (rail) await seedTeam({ rail, include: [m], online: opts.online === false ? [] : [m], exclusive: false });
  if (then) await then(m);
  return {
    token: merchantToken(m),
    cached: merchantCache(m, { acceptedCurrencies: [opts?.currency ?? 'INR'], ...extraCache }), who: m.merchantId,
  };
} });

export const PROFILES = {
  // ── Players ────────────────────────────────────────────────────────────
  'phantom-agent': {
    what: 'a phantom agent (phantom_access BOTH) — the only account that sees GHOST MODE',
    ...player({}, (u) => pgQuery(`UPDATE users SET phantom_access = 'BOTH' WHERE user_id = $1`, [u.userId], 'profile_phantom')),
  },
  'player-zero-balance': {
    what: 'a verified player with no money',
    ...player({ balancePaise: 0 }),
  },
  'player-unverified': {
    what: 'a player who has not shared their contact or joined the channel — the gate',
    ...player({ verified: false }),
  },
  'player-blocked': {
    what: 'a player an admin has blocked',
    ...player({}, (u) => pgQuery(
      `UPDATE users SET is_blocked = TRUE, status = 'BLOCKED', block_reason = 'profile', blocked_at = now() WHERE user_id = $1`,
      [u.userId], 'profile_block',
    )),
  },
  // ── Staff ─────────────────────────────────────────────────────────────
  'subadmin-none': {
    what: 'a sub-admin granted no areas',
    ...staff({ isSubAdmin: true, keys: [] }),
  },
  'subadmin-analytics': {
    what: 'a sub-admin granted only "View analytics"',
    ...staff({ isSubAdmin: true, keys: ['canViewAnalytics'] }),
  },
  'subadmin-players': {
    what: 'a sub-admin granted players and transactions, nothing that moves money',
    ...staff({ isSubAdmin: true, keys: ['canManageUsers', 'canViewTransactions'] }),
  },
  'subadmin-all': {
    what: 'a sub-admin granted every area',
    ...staff({ isSubAdmin: true, keys: PERMISSION_KEYS }),
  },
  'queue-manager': {
    what: 'a queue manager (no areas; works the payment queue)',
    ...staff({ isQueueManager: true }),
  },
  // ── Merchants ─────────────────────────────────────────────────────────
  'merchant-upi': {
    what: 'an INR merchant in a working UPI/bank team',
    ...merchant({}, null, undefined, 'UPI_BANK'),
  },
  'merchant-usdt': {
    what: 'a USDT merchant in a working USDT team, with an address on both chains',
    ...merchant({ currency: 'USDT', usdtAddressTrc20: trc20(), usdtAddressBep20: bep20() }, null, undefined, 'USDT'),
  },
  'merchant-offline': {
    what: 'a cash-team merchant who is offline',
    ...merchant({ online: false }, null, { isOnline: false }, 'CASH'),
  },
  'merchant-paused': {
    what: 'a cash-team merchant whose assignment is paused (three unpaid buys)',
    ...merchant({}, (m) => pauseAssignment(m.merchantId, 'profile: three unpaid buys'), undefined, 'CASH'),
  },
  // The server refuses this session (merchantAuth: 403), so the panel signs
  // itself out; `signsOut` is what its sign-in form must then say (run.js).
  'merchant-suspended': {
    what: 'a cash-team merchant an admin suspended while they were signed in',
    signsOut: /Account suspended/,
    ...merchant({}, (m) => suspendMerchant(m.merchantId, 'profile', { actor: 'profile' }), { status: 'SUSPENDED' }, 'CASH'),
  },
  // No `merchant-pending`: a merchant not yet approved cannot sign in at all
  // (the login refuses "Application pending approval."), so a pending
  // merchant holding a session is a state the platform cannot produce (§32
  // S16; PROJECT_STATUS §3.8 item 6).
  // Every other merchant profile, and the drive's own merchant, is a MEMBER,
  // so the supervisor's half of the Team page (create a team, add a member,
  // pool requests, a member's log, the dispute thread) was in no inventory.
  // Its members are left offline: a profile is an account to look at, and
  // must not change what the drive pass's own merchant is routed.
  'merchant-supervisor': {
    what: 'a supervisor running one full cash team, its members offline',
    panel: 'merchant-panel',
    seed: async () => {
      const { supervisor } = await seedTeam({ rail: 'CASH', online: [], exclusive: false });
      // `isSupervisor` as the server's profile says it (formatMerchant), so the
      // cached first paint already has no online switch to offer.
      return { token: merchantToken(supervisor), cached: merchantCache(supervisor, { isOnline: false, isSupervisor: true }), who: supervisor.merchantId };
    },
  },
};

/** One profile's account, shaped as `seedActors()` shapes its three. */
export async function seedProfile(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`Unknown profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}`);
  const { token, cached, who } = await p.seed();
  return { panel: p.panel, what: p.what, who, actors: { [p.panel]: token }, cached: { [p.panel]: cached } };
}

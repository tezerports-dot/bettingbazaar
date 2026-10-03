// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { createMerchant, approveMerchant, setOnline } from '#db/repositories/merchants.js';
import { setSupervisorRole, createTeam, addMember, approveMember, TEAM_SIZE } from '#db/repositories/teams.js';
import { createRequest, fulfilRequest, getPool } from '#db/repositories/teamPools.js';
import { setCashReady, RAILS } from '#db/repositories/teamRouting.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { rid } from './harness.js';

const mob = () => String(6000000000 + Math.floor(Math.random() * 3999999999));

// `merchants_usdt_trc20_unique` / `..._bep20_unique`: two merchants may not hold
// the same address (§25 — the address IS where the player's USDT lands). So the
// driver mints a fresh one per merchant rather than reusing a literal.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const trc20 = () => 'T' + Array.from({ length: 33 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
export const bep20 = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/**
 * Give one actor the two rows a verified person HAS, for their own audience.
 *
 * ── Why this is one function and not three ────────────────────────────────
 * §33.7 made the gate per-panel: a player verifies through the PLAYER fleet
 * and channel, a merchant through the MERCHANT ones, an admin through STAFF.
 * That is three near-identical inserts differing only in the audience, which
 * is §5's shape — and the half that gets forgotten is always the one nobody
 * was thinking about when they gated the next panel. The audience is a
 * PARAMETER so there is nothing to forget.
 *
 * These are the rows the contact-share webhook and the membership check write.
 * The harness writes them directly because `registerBot` verifies the token
 * against Telegram itself, and there is no Telegram here.
 *
 * Skipped when that audience has no channel: there is nothing to be a member
 * of, and `configureTelegram()` is what arranges for there to be one.
 */
export async function verifyActor({ userId, mobile, audience }) {
  const active = await pgQuery(
    `SELECT generation FROM telegram_configs WHERE active AND audience = $1 LIMIT 1`,
    [audience], 'e2e_active_generation',
  );
  if (!active.rows[0]) return false;
  await pgQuery(
    `INSERT INTO telegram_identities (
       telegram_user_id, audience, user_id, phone, contact_shared_at,
       contact_active, channel_status, channel_checked_at,
       channel_generation, linked_generation)
     VALUES ($1, $2, $3, $4, now(), TRUE, 'member', now(), $5, $5)
     ON CONFLICT (telegram_user_id, audience) DO NOTHING`,
    [`e2e-tg-${userId}`, audience, userId, mobile, active.rows[0].generation],
    'e2e_verify_actor',
  );
  return true;
}

export async function seedPlayer({ balancePaise = 0, verified = true } = {}) {
  const userId = rid('player');
  // The number is held in a LOCAL, not read back off the projection. The
  // identity insert below needs it and `phone` is NOT NULL, so a projection
  // that ever stops carrying `mobile` would abort the whole suite mid-scenario
  // with a constraint error naming a table the scenario never mentions — which
  // is exactly what it did.
  const mobile = mob();
  const user = await db.users.createUser({
    userId, username: userId, mobile, status: 'ACTIVE',
  });

  // ── The Telegram verification a real player cannot deposit without ──────
  //
  // §32 S19, and it cost a whole suite its meaning. Every money scenario here
  // runs behind `requireChannelMembership`, which refuses an unlinked player
  // with TELEGRAM_NOT_LINKED — but ONLY when a channel is configured. Nothing
  // here configured one, so the suite passed on a database where nobody had,
  // and answered 403 on four scenarios the moment it met a database where
  // somebody had. It was reading whatever the database happened to hold.
  //
  // So the seed ESTABLISHES it, through the same rows the webhook writes: a
  // contact share proving the mobile, and a channel membership stamped with
  // the generation that is actually live. `verified: false` is available for a
  // scenario that wants to test the gate itself.
  //
  // Skipped silently when no channel is configured — there is nothing to be a
  // member of, and the gate admits (§31's owner decision, 2026-09-17).
  if (verified) await verifyActor({ userId, mobile, audience: 'PLAYER' });

  if (balancePaise > 0) {
    const { creditDeposit } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditDeposit(userId, balancePaise / 100, `${userId}_seed`);
  }
  return { ...user, userId, mobile };
}

/**
 * A merchant: the trading identity, its LOGIN row, and the link between them.
 *
 * ── A merchant holds no tokens, and is not on a rail by itself ─────────────
 * Since Step 2c (PROJECT_STATUS §3.10) a merchant serves orders only as a
 * MEMBER of a working team, the rail is the team supervisor's, and the tokens
 * are the team's POOL. So this seeds an approved, online merchant and nothing
 * more; `seedTeam` below is what puts merchants where orders can reach them.
 *
 * `tokensPaise` and `cashDenominationPaise` are REFUSED, not ignored. Both
 * named things the platform no longer has (a merchant wallet; a merchant
 * approved for one ATM denomination), and a caller still passing them is a
 * scenario still describing the old model — silently dropping the argument
 * would let it carry on asserting against tokens nobody was given.
 */
export async function seedMerchant({
  currency = 'INR', approve = true, online = true,
  usdtAddressTrc20 = null, usdtAddressBep20 = null,
  verified = true, tokensPaise, cashDenominationPaise,
} = {}) {
  if (tokensPaise !== undefined || cashDenominationPaise !== undefined) {
    throw new Error('seedMerchant: tokensPaise/cashDenominationPaise are gone — a merchant holds no tokens and '
      + 'is on no rail by itself. Put it in a team: seedTeam({ rail, poolTokens, include: [merchant] }).');
  }
  const name = rid('merch');
  // Held in a LOCAL for the same reason `seedPlayer` holds the player's: the
  // identity row's `phone` is NOT NULL and a projection may not carry it.
  const mobile = mob();
  // `merchants_bank_account_unique` is (account number, IFSC), so every seeded
  // merchant gets its own account — a literal shared by two merchants is a row
  // the platform refuses (§32 S16).
  const accountNo = String(100000000000 + Math.floor(Math.random() * 899999999999));
  const merchant = await createMerchant({
    name, username: name, mobile, email: `${name}@example.test`,
    currency, status: 'PENDING',
    bankDetails: currency === 'INR'
      ? { accountNo, ifsc: 'HDFC0000001', accountHolderName: name, upiId: `${name}@upi`, bankName: 'HDFC Bank' }
      : null,
    usdtAddressTrc20, usdtAddressBep20,
  });
  const id = merchant._id ?? merchant.merchantId;

  // ── The merchant's LOGIN row, and the LINK to it ────────────────────────
  // A real merchant signup writes a `users` row (the login) as well as a
  // `merchants` row (the trading identity), and points the second at the first
  // — §33.5, and `createMerchantAccount` does all of it in one transaction.
  // `createMerchant` writes only the trading identity and leaves
  // `merchants.user_id` NULL, so every seeded merchant was an account that
  // cannot exist (§32 S16).
  //
  // It cost nothing until something looked a merchant up as an ACCOUNT. The
  // verification gate does — `account_type` is what decides which bot and
  // channel a merchant verifies through — and `merchantAuth` resolves it as
  // `req.userId = merchant.userId`, which was NULL. So
  // `GET /api/merchant/verification` answered 401, the gate rendered NOTHING,
  // and a browser pass reported an un-gated merchant panel. The panel was
  // right; the fixture was describing a merchant with no login.
  const merchantUserId = rid('muser');
  await pgQuery(
    `INSERT INTO users (user_id, username, mobile, password_hash, status,
                        roles, account_type)
     VALUES ($1, $2, $3, $4, 'ACTIVE', ARRAY['merchant'], 'MERCHANT')
     ON CONFLICT (mobile, account_type) DO NOTHING`,
    [merchantUserId, merchant.username ?? name, mobile, 'x'.repeat(60)],
    'e2e_merchant_login',
  );
  // The MERCHANT panel gates too (§33.7), through the merchant fleet and the
  // merchant channel — not the player's. Without this the panel is correct and
  // every control behind its modal is unreachable.
  if (verified) await verifyActor({ userId: merchantUserId, mobile, audience: 'MERCHANT' });
  await pgQuery(`UPDATE merchants SET user_id = $2 WHERE merchant_id = $1`,
                [id, merchantUserId], 'e2e_merchant_link');

  if (approve) await approveMerchant(id, { actor: 'e2e' });
  if (online) await setOnline(id, true);
  return { ...merchant, _id: id, merchantId: id, userId: merchantUserId, mobile };
}

/**
 * Sell `tokens` into a team's pool the way the platform does it: the
 * supervisor's BUY request, then an admin's fulfilment recording what was paid
 * (`teamPools.js` — one transaction moving TOKEN_SUPPLY → TEAM_FLOAT, the pool
 * row, its ledger entry and the consideration). Never a pool row written by
 * hand: TEAM_FLOAT must equal the sum of the pools, and only this path keeps
 * it so.
 *
 * Scenarios that are ABOUT funding a pool go through the two HTTP routes
 * instead (s6); this is the seed's shortcut through the same repository calls
 * those routes make.
 */
export async function fundTeam(team, tokens) {
  const r = await createRequest({
    teamId: team.teamId, supervisorId: team.supervisor.merchantId,
    direction: 'BUY', tokenAmountPaise: tokens * 100, note: 'e2e seed',
  });
  if (!r.ok) throw new Error(`fundTeam: pool request refused: ${r.reason}`);
  const done = await fulfilRequest({
    requestId: r.requestId, actor: 'e2e-admin',
    consideration: { currency: 'INR', fiatAmountMinor: tokens * 100, rateUsed: null },
  });
  if (!done.ok) throw new Error(`fundTeam: pool fulfilment refused: ${done.reason}`);
  return done.pool;
}

/**
 * A WORKING team on one rail: a supervisor approved for `rail`, and ten
 * approved members — every one a full `seedMerchant` with a login, so a
 * scenario can act as whichever member routing picks.
 *
 * Built through the repositories the admin and supervisor routes call
 * (`setSupervisorRole`, `createTeam`, `addMember`, `approveMember`), so the
 * team is one the platform could have produced — the same calls
 * `teamFixture.js` makes for the vitest tiers. That fixture is not imported
 * here because its `cleanup()` DELETES the team and its merchants, and this
 * tier never deletes what it seeds: its orders are left behind referring to
 * their merchant and team, and a deleted team would leave them pointing at
 * nothing (trap 10 — this tier asserts deltas, never global state).
 *
 *   include    merchants (from `seedMerchant`) to put in it; padded to ten.
 *   online     which members are online — default ALL of them. The others are
 *              taken offline.
 *   ready      CASH only: members who have pressed Ready. Through the same
 *              writer `PUT /api/merchant/cash-ready` calls (`setCashReady`),
 *              so the flag is one a member could have set; s4 presses it over
 *              HTTP where the press itself is under test.
 *   exclusive  default TRUE: every member of every OTHER team on this rail is
 *              taken offline, so routing on the rail reaches this team and
 *              nobody else. Teams from earlier runs (this tier never deletes)
 *              would otherwise compete for the scenario's orders, and which
 *              member a buy lands on — and whose pool holds it — would depend
 *              on whatever the database happened to hold (§32 S19).
 *   poolTokens tokens sold into the pool through `fundTeam`.
 *
 * Returns { teamId, rail, supervisor, members, byId(merchantId) }.
 */
export async function seedTeam({
  rail = 'UPI_BANK', poolTokens = 0, include = [], online = null, ready = [], exclusive = true,
} = {}) {
  if (!RAILS[rail]) throw new Error(`seedTeam: unknown rail ${rail}`);
  if (include.length > TEAM_SIZE) throw new Error(`seedTeam: a team has ${TEAM_SIZE} members, not ${include.length}`);
  const currency = rail === RAILS.USDT ? 'USDT' : 'INR';

  // The supervisor does no transactions (owner, 2026-10-02) — offline, and
  // never a member: `team_roles_disjoint` refuses one account being both.
  const supervisor = await seedMerchant({ currency, online: false });
  const role = await setSupervisorRole(supervisor.merchantId, { rail });
  if (!role.ok) throw new Error(`seedTeam: supervisor refused: ${role.reason}`);
  const made = await createTeam({ supervisorId: supervisor.merchantId, name: rid(`team-${rail}`) });
  if (!made.ok) throw new Error(`seedTeam: team refused: ${made.reason}`);
  const { teamId } = made;

  const members = [...include];
  while (members.length < TEAM_SIZE) {
    // A USDT member holds an address on BOTH chains unless the scenario
    // brings its own, so the padding can serve either network.
    members.push(await seedMerchant({
      currency, online: false,
      ...(rail === RAILS.USDT ? { usdtAddressTrc20: trc20(), usdtAddressBep20: bep20() } : {}),
    }));
  }
  for (const m of members) {
    const added = await addMember({ teamId, supervisorId: supervisor.merchantId, merchantRef: m.merchantId, actor: supervisor.merchantId });
    if (!added.ok) throw new Error(`seedTeam: add ${m.merchantId} refused: ${added.reason}`);
    const approved = await approveMember({ merchantId: m.merchantId, actor: 'e2e-admin' });
    if (!approved.ok) throw new Error(`seedTeam: approve ${m.merchantId} refused: ${approved.reason}`);
  }

  if (exclusive) {
    await pgQuery(
      `UPDATE merchants SET is_online = FALSE, cash_ready = FALSE, last_online_toggle = now()
        WHERE is_online AND merchant_id IN (
          SELECT tm.merchant_id FROM team_members tm
            JOIN teams t ON t.team_id = tm.team_id
            JOIN merchants s ON s.merchant_id = t.supervisor_id
           WHERE s.supervisor_rail = $1 AND tm.team_id <> $2)`,
      [rail, teamId], 'e2e_team_exclusive');
  }
  const onlineIds = new Set((online ?? members).map((m) => m.merchantId ?? m));
  for (const m of members) await setOnline(m.merchantId, onlineIds.has(m.merchantId));
  for (const m of ready) {
    const set = await setCashReady(m.merchantId ?? m, true);
    if (!set.ok) throw new Error(`seedTeam: Ready refused for ${m.merchantId ?? m}: ${set.reason}`);
  }

  const team = { teamId, rail, supervisor, members };
  if (poolTokens > 0) await fundTeam(team, poolTokens);
  const byId = new Map(members.map((m) => [m.merchantId, m]));
  return { ...team, byId: (id) => byId.get(String(id)) ?? null };
}

/**
 * What one ORDER did to a team pool and to the treasury, read by the order's
 * own id rather than by diffing totals.
 *
 * Trap 10: the pool totals and the treasury floats are shared — the server's
 * `order-assignment` and `team-pool-hold-sweep` crons run underneath every
 * scenario and can move them (a PENDING_QUEUE order left by an earlier run is
 * assigned to the first team that comes online on its rail). So a scenario
 * asserts the rows THIS order wrote: its `team_pool_entries` (ref_id = the
 * order) and the two treasury movements named after it, `team_buy_<oid>`
 * (spendForBuy) and `team_sell_<oid>` (creditSellToPool).
 *
 * Returns { entries: [{kind, teamId, available, held}], legs: {movementId: {ACCOUNT: paise}} }.
 */
export async function orderPoolTrail(orderId) {
  const oid = String(orderId);
  const { rows: e } = await pgQuery(
    `SELECT kind, team_id, available_delta_paise, held_delta_paise
       FROM team_pool_entries WHERE ref_id = $1 ORDER BY id`, [oid], 'e2e_order_pool_entries');
  const { rows: t } = await pgQuery(
    `SELECT movement_id, account, amount_paise FROM treasury_entries
      WHERE movement_id = ANY($1::text[]) ORDER BY id`,
    [[`team_buy_${oid}`, `team_sell_${oid}`]], 'e2e_order_treasury_legs');
  const legs = {};
  for (const r of t) (legs[r.movement_id] ??= {})[r.account] = Number(r.amount_paise);
  return {
    entries: e.map((r) => ({
      kind: r.kind, teamId: r.team_id,
      available: Number(r.available_delta_paise), held: Number(r.held_delta_paise),
    })),
    legs,
  };
}

/** The pool's two halves and the treasury's two floats, as one snapshot to diff. */
export async function poolAndFloats(teamId) {
  const pool = await getPool(teamId);
  const t = await getTreasuryBalances();
  return {
    available: pool.availablePaise, held: pool.heldPaise,
    teamFloat: t[ACCOUNTS.TEAM_FLOAT], userFloat: t[ACCOUNTS.USER_FLOAT],
  };
}

// The admin 2FA guard (F-011) is ON, so an admin with no authenticator is
// refused with TWO_FACTOR_ENROLMENT_REQUIRED before reaching any handler.
// That is the product working; the driver enrols the seeded admin so the
// scenarios past the door can run.
/**
 * A STAFF account that is not the full admin: a sub-admin, a queue manager, or
 * a staff login holding neither yet.
 *
 * Built the way `/api/admin/sub-admins` builds one — a STAFF row, then the roles
 * and the grant — never a player row with staff flags written onto it. That
 * shortcut is refused by `users_staff_flags_need_staff` since 2026-10-01: a
 * staff member holds a SEPARATE account (owner), and a flag on a PLAYER row was
 * staff authority riding a player's session. Two mutate cases still took the
 * shortcut and failed on the constraint, which is the constraint working.
 */
export async function seedStaff({ subAdmin = false, queueManager = false, permissions = {}, verified = true } = {}) {
  const userId = rid('staff');
  const mobile = mob();
  const { user } = await db.users.createUser({
    userId, username: userId, mobile, status: 'ACTIVE', accountType: 'STAFF',
  });
  const roles = [subAdmin ? 'subadmin' : null, queueManager ? 'queue_manager' : null].filter(Boolean);
  if (roles.length) await db.users.setRoles(userId, roles);
  if (subAdmin) await db.users.updateUser(userId, { subAdminPermissions: permissions });
  if (verified) await verifyActor({ userId, mobile, audience: 'STAFF' });
  return { ...user, userId, mobile };
}

export async function seedAdmin({ enrol2fa = true, verified = true } = {}) {
  const userId = rid('admin');
  const mobile = mob();
  const user = await db.users.createUser({
    userId, username: userId, mobile, status: 'ACTIVE',
    // ── STAFF, and leaving it out was §32 S16 ────────────────────────────
    // `account_type` defaults to PLAYER, so this seeded a row with
    // `is_admin = true` sitting in the PLAYER population — a state the
    // platform cannot produce: `/api/admin/sub-admins` writes STAFF, and the
    // staff login door scopes its read by the type, so a real admin is never
    // a PLAYER row.
    //
    // It cost nothing until something READ the column. The verification gate
    // derives a person's Telegram audience from it (§33.5), so a browser pass
    // opened the admin panel and was told to open @bb_player_signin — the
    // PLAYER fleet's bot, for an admin. The gate was right; the fixture was
    // describing an account that does not exist.
    accountType: 'STAFF',
    isAdmin: true,
  });
  if (enrol2fa) {
    const { pgQuery } = await import('#db/client.js');
    await pgQuery(
      `UPDATE users SET two_factor_enabled = TRUE, two_factor_enrolled_at = now(),
                        two_factor_secret = $2
        WHERE user_id = $1`,
      [userId, 'e2e-enrolled-secret'], 'e2e_enrol_admin',
    );
  }
  // STAFF gates the moment a staff bot and channel exist — the bootstrap
  // exemption (§2, §33.7) covers only `no_bot`/`no_channel`, and is
  // deliberately that narrow. On a platform where somebody HAS configured the
  // staff surface, an unlinked admin is blocked like anybody else.
  if (verified) await verifyActor({ userId, mobile, audience: 'STAFF' });
  return { ...user, userId, mobile };
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { createMerchantWithWallet, approveMerchant, setOnline, updateMerchant } from '#db/repositories/merchants.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';
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
 * against Telegram itself, and there is no Telegram here — the same reason
 * the KYC rows below are walked through the real transitions instead of being
 * INSERTed, stated the other way round.
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

export async function seedPlayer({ kycStatus = 'APPROVED', balancePaise = 0, verified = true } = {}) {
  const userId = rid('player');
  // The number is held in a LOCAL, not read back off the projection. The
  // identity insert below needs it and `phone` is NOT NULL, so a projection
  // that ever stops carrying `mobile` would abort the whole suite mid-scenario
  // with a constraint error naming a table the scenario never mentions — which
  // is exactly what it did.
  const mobile = mob();
  const user = await db.users.createUser({
    userId, username: userId, mobile, status: 'ACTIVE', kycStatus,
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
  // ── The KYC ROW a real submission writes ───────────────────────────────
  // §32 S16, a third instance in this file. `createUser` sets
  // `users.kyc_status` and nothing else, so a seeded player had a status and
  // no `user_kyc` row — a state the platform cannot produce, because every
  // real status arrives through `transitionKyc`, which writes the row, the
  // column and a `kyc_transitions` entry in ONE transaction.
  //
  // It cost nothing until something DECIDED on that row. `approveKyc` answered
  // 409 "Cannot approve KYC from unknown status" for every seeded player, so no
  // test could ever exercise an approval — the one decision that grants
  // withdrawal access.
  //
  // Opened at PENDING_SUBMISSION and then walked forward through the real
  // transitions, so the seed reaches its requested status the same way a person
  // does and `KYC_ALLOWED_FROM` stays the only rule about what is reachable.
  if (kycStatus && kycStatus !== 'PENDING_SUBMISSION') {
    await db.kyc.openKyc({ userId });
    await db.kyc.transitionKyc({ userId, to: 'PENDING_APPROVAL', actor: 'e2e' });
    if (kycStatus === 'APPROVED') {
      await db.kyc.transitionKyc({ userId, to: 'APPROVED', actor: 'e2e' });
    } else if (kycStatus === 'REJECTED') {
      await db.kyc.transitionKyc({
        userId, to: 'REJECTED', actor: 'e2e', reason: 'e2e seeded rejection',
      });
    }
  } else {
    await db.kyc.openKyc({ userId });
  }

  if (balancePaise > 0) {
    const { creditDeposit } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditDeposit(userId, balancePaise / 100, `${userId}_seed`);
  }
  return { ...user, userId, mobile };
}

/**
 * ── `cashDenominationPaise` is what makes a merchant a CASH merchant ────────
 * It is not a second rail (§2: `accepted_currencies` is exactly one entry). An
 * ATM merchant is an INR merchant an admin has told which single denomination
 * they stand at, and `CashLinks.tsx` renders its whole screen off that: with
 * no denomination it shows an empty state explaining the account is not
 * approved for the ATM rail, and nothing to press.
 *
 * Which is why this option exists. The browser pass seeded a plain INR
 * merchant, so `/cash-links` rendered that empty state on every run — zero
 * controls, and the pass reported `ok`. The entire supply side of the CASH_ATM
 * rail had never once been opened by anything that clicks.
 *
 * Must be one of `CASH_DENOMINATIONS_PAISE`; the column's CHECK refuses
 * anything else (verified: 50_000_000 was refused by name).
 */
export async function seedMerchant({
  currency = 'INR', approve = true, tokensPaise = 0, online = true,
  usdtAddressTrc20 = null, usdtAddressBep20 = null, cashDenominationPaise = null,
  verified = true,
} = {}) {
  const name = rid('merch');
  // Held in a LOCAL for the same reason `seedPlayer` holds the player's: the
  // identity row's `phone` is NOT NULL and a projection may not carry it.
  const mobile = mob();
  const merchant = await createMerchantWithWallet({
    name, username: name, mobile, email: `${name}@example.test`,
    passwordHash: 'x'.repeat(60), currency, status: 'PENDING',
    bankDetails: currency === 'INR'
      ? { accountNumber: '000111222333', ifsc: 'HDFC0000001', accountHolder: name, upiId: `${name}@upi` }
      : null,
    usdtAddressTrc20, usdtAddressBep20,
  });
  const id = merchant._id ?? merchant.merchantId;

  // ── The merchant's LOGIN row, and the LINK to it ────────────────────────
  // A real merchant signup writes a `users` row (the login) as well as a
  // `merchants` row (the trading identity), and points the second at the first
  // — §33.5, and `createMerchantAccount` does all of it in one transaction.
  // `createMerchantWithWallet` writes only the trading identity and leaves
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
    `INSERT INTO users (user_id, username, mobile, password_hash, status, kyc_status,
                        roles, account_type)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 'PENDING_SUBMISSION', ARRAY['merchant'], 'MERCHANT')
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

  if (cashDenominationPaise !== null) {
    await updateMerchant(id, { cashDenominationPaise: Number(cashDenominationPaise) });
  }
  if (approve) await approveMerchant(id, { actor: 'e2e' });
  if (online) await setOnline(id, true);
  if (tokensPaise > 0) {
    await creditMerchantTokens({
      merchantId: id, amount: tokensPaise / 100,
      txId: `${id}_seed_float`, reason: 'e2e float',
    });
  }
  return { ...merchant, _id: id, merchantId: id, userId: merchantUserId, mobile };
}

// The admin 2FA guard (F-011) is ON, so an admin with no authenticator is
// refused with TWO_FACTOR_ENROLMENT_REQUIRED before reaching any handler.
// That is the product working; the driver enrols the seeded admin so the
// scenarios past the door can run.
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
    kycStatus: 'APPROVED', isAdmin: true,
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

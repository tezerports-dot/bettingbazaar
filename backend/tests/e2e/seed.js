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
  if (verified) {
    const active = await pgQuery(
      `SELECT generation FROM telegram_configs WHERE active AND audience = 'PLAYER' LIMIT 1`,
      [], 'e2e_active_player_generation',
    );
    if (active.rows[0]) {
      await pgQuery(
        `INSERT INTO telegram_identities (
           telegram_user_id, audience, user_id, phone, contact_shared_at,
           contact_active, channel_status, channel_checked_at,
           channel_generation, linked_generation)
         VALUES ($1, 'PLAYER', $2, $3, now(), TRUE, 'member', now(), $4, $4)
         ON CONFLICT (telegram_user_id, audience) DO NOTHING`,
        [`e2e-tg-${userId}`, userId, mobile, active.rows[0].generation],
        'e2e_verify_player',
      );
    }
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
} = {}) {
  const name = rid('merch');
  const merchant = await createMerchantWithWallet({
    name, username: name, mobile: mob(), email: `${name}@example.test`,
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
    [merchantUserId, merchant.username ?? name, merchant.mobile, 'x'.repeat(60)],
    'e2e_merchant_login',
  );
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
  return { ...merchant, _id: id, merchantId: id, userId: merchantUserId };
}

// The admin 2FA guard (F-011) is ON, so an admin with no authenticator is
// refused with TWO_FACTOR_ENROLMENT_REQUIRED before reaching any handler.
// That is the product working; the driver enrols the seeded admin so the
// scenarios past the door can run.
export async function seedAdmin({ enrol2fa = true } = {}) {
  const userId = rid('admin');
  const user = await db.users.createUser({
    userId, username: userId, mobile: mob(), status: 'ACTIVE',
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
  return { ...user, userId };
}

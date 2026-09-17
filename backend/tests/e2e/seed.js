// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { db } from '#db';
import { createMerchantWithWallet, approveMerchant, setOnline } from '#db/repositories/merchants.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';
import { rid } from './harness.js';

const mob = () => String(6000000000 + Math.floor(Math.random() * 3999999999));

// `merchants_usdt_trc20_unique` / `..._bep20_unique`: two merchants may not hold
// the same address (§25 — the address IS where the player's USDT lands). So the
// driver mints a fresh one per merchant rather than reusing a literal.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const trc20 = () => 'T' + Array.from({ length: 33 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
export const bep20 = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export async function seedPlayer({ kycStatus = 'APPROVED', balancePaise = 0 } = {}) {
  const userId = rid('player');
  const user = await db.users.createUser({
    userId, username: userId, mobile: mob(), status: 'ACTIVE', kycStatus,
  });
  if (balancePaise > 0) {
    const { creditDeposit } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditDeposit(userId, balancePaise / 100, `${userId}_seed`);
  }
  return { ...user, userId, mobile: user.mobile };
}

export async function seedMerchant({
  currency = 'INR', approve = true, tokensPaise = 0, online = true,
  usdtAddressTrc20 = null, usdtAddressBep20 = null,
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
  if (approve) await approveMerchant(id, { actor: 'e2e' });
  if (online) await setOnline(id, true);
  if (tokensPaise > 0) {
    await creditMerchantTokens({
      merchantId: id, amount: tokensPaise / 100,
      txId: `${id}_seed_float`, reason: 'e2e float',
    });
  }
  return { ...merchant, _id: id, merchantId: id };
}

// The admin 2FA guard (F-011) is ON, so an admin with no authenticator is
// refused with TWO_FACTOR_ENROLMENT_REQUIRED before reaching any handler.
// That is the product working; the driver enrols the seeded admin so the
// scenarios past the door can run.
export async function seedAdmin({ enrol2fa = true } = {}) {
  const userId = rid('admin');
  const user = await db.users.createUser({
    userId, username: userId, mobile: mob(), status: 'ACTIVE',
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

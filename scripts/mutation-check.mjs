// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Mutation harness — break the code, confirm a test FAILS, restore.
 *
 * A passing test suite proves nothing about a test that would pass anyway. Each
 * entry below names one behaviour this branch relies on, the smallest edit that
 * removes it, and the test that must go red when it does. A mutation that
 * survives is a hole in the suite, reported as SURVIVED rather than skipped.
 *
 *   node scripts/mutation-check.mjs            all mutations
 *   node scripts/mutation-check.mjs unit       only the ones whose test is a unit test
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const UNIT = 'vitest.config.ts';
const PG = 'vitest.pg.config.ts';

const MUTATIONS = [
  // ── The fee, in the store that decides it ─────────────────────────────────
  {
    id: 'M15', file: 'database/repositories/bets.core.js', config: PG,
    test: 'database/tests/betSettlementPg.test.js',
    why: 'the settling UPDATE does not write the fee',
    from: `      \`UPDATE bets SET status = $2, payout_paise = $3, platform_fee_paise = $5,
                       settled_at = now(), updated_at = now()
        WHERE bet_id = $1 AND status = $4
        RETURNING updated_at\`,
      [ctx.bid, spec.to, payoutPaise, spec.expect, platformFeePaise],`,
    to: `      \`UPDATE bets SET status = $2, payout_paise = $3,
                       settled_at = now(), updated_at = now()
        WHERE bet_id = $1 AND status = $4
        RETURNING updated_at\`,
      [ctx.bid, spec.to, payoutPaise, spec.expect],`,
  },
  {
    id: 'M16', file: 'database/repositories/bets.core.js', config: PG,
    test: 'database/tests/betSettlementPg.test.js',
    why: 'a fractional or negative fee is accepted and silently truncated',
    from: `  if (!Number.isInteger(platformFeePaise) || platformFeePaise < 0) {
    throw new TypeError(\`\${spec.name}Bet: platformFeePaise must be a non-negative integer, got \${platformFeePaise}\`);
  }`,
    to: '',
  },
  // ── A deposit moves tokens; it must not create or destroy them ────────────
  {
    // Retargeted 2026-09-07: this movement lived inline in payment.routes.js and
    // now lives in depositCredit.js's `moveDepositMoney`, which BOTH routes that
    // complete a deposit call — the merchant confirm and the admin queue
    // override. The mutation therefore covers two call sites where it used to
    // cover one. It was the admin override disagreeing with this arithmetic
    // that minted tokens, so aiming it at the shared owner is the point.
    id: 'M22', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditConservation.test.js',
    why: 'the merchant is debited the DEPOSIT SHARE while the user is credited the whole amount',
    from: `    merchantId: order.merchantId, amount: total,`,
    to: `    merchantId: order.merchantId, amount: depositCredit,`,
  },
  {
    id: 'M23', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditSplit.test.js',
    why: 'the `||` fallback is back — a legal 0 deposit share reads as absent',
    from: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };
  return { depositCredit: deposit, reserveCredit: reserve, total, split: true };`,
    to: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };
  return { depositCredit: deposit || total, reserveCredit: reserve, total, split: true };`,
  },
  {
    id: 'M24', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditSplit.test.js',
    why: 'a partial split is accepted, so part of the deposit goes unaccounted for',
    from: `    && Math.abs((deposit + reserve) - total) < 1e-9;`,
    to: `    && true;`,
  },
  {
    id: 'M25', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditConservation.test.js',
    why: 'the fallback credits nothing instead of the whole amount — tokens burned',
    from: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };`,
    to: `  if (!usable) return { depositCredit: 0, reserveCredit: 0, total, split: false };`,
  },
  {
    id: 'M30', file: 'database/repositories/bets.core.js', config: PG,
    test: 'database/tests/betSettlementPg.test.js',
    why: 'resolveBetId stops looking at public_id, so a placed bet is unreachable',
    from: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 OR public_id = $1 LIMIT 1\`,`,
    to: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 LIMIT 1\`,`,
  },
  // ── Money-domain READS follow authority (docs/MONEY_READS_MIGRATION.md) ───
  {
    id: 'M31', file: 'database/repositories/merchantWallets.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'committed tokens are reported as spendable, admitting orders nobody can fund',
    from: `const spendable = (balances) => paiseToRupees(balances.available);`,
    to: `const spendable = (balances) => paiseToRupees(balances.available + balances.reserved + balances.settlement);`,
  },
  {
    id: 'M32', file: 'backend/domains/merchant/merchant.assignment.routes.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'an eligibility gate goes back to reading a stored balance off the merchant record',
    from: `  const balance = await getMerchantTokenBalance(merchantId);`,
    to: `  const balance = merchant.tokenBalance < order.tokenAmount ? 0 : merchant.tokenBalance;`,
  },
  // ── The accounts table: four properties, each verified to be load-bearing ──
  {
    id: 'M43', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'a racing signup on one mobile creates two accounts',
    from: `     ON CONFLICT (mobile) DO NOTHING\n`,
    to: '',
  },
  {
    id: 'M44', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'a write to an unknown column is silently discarded again',
    from: `  if (unknown.length) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M45', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: "BIGINT stays a string, so '900' >= 1000 is true",
    from: `const toInt = (v) => (v == null ? null : Number(v));`,
    to: `const toInt = (v) => v;`,
  },
  {
    id: 'M46', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'the denormalised kyc_status can be written outside the decision transaction',
    from: `  if (!client) throw new Error('setKycStatus must run inside the transaction that records the decision');`,
    to: `  if (!client) return null;`,
  },
  // ── The sign-in surface: expiry, single use, and disclosure control ────────
  {
    id: 'M47', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramPg.test.js',
    why: 'a forwarded login link can be redeemed twice, minting two sessions',
    from: `        AND consumed_at IS NULL\n`,
    to: '',
  },
  {
    id: 'M48', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramPg.test.js',
    why: 'an expired onboarding stays readable until a sweep happens to run',
    from: `      WHERE telegram_user_id = $1 AND expires_at > now()\`,
    [String(telegramUserId)], 'tg_pending_get',`,
    to: `      WHERE telegram_user_id = $1\`,
    [String(telegramUserId)], 'tg_pending_get',`,
  },
  {
    id: 'M49', file: 'database/repositories/identity.js', config: PG,
    test: 'database/tests/identityPg.test.js',
    why: 'two concurrent exports disclose the same Aadhaar in two files',
    from: `          FOR UPDATE SKIP LOCKED)`,
    to: `          )`,
  },
  {
    id: 'M50', file: 'database/repositories/identity.js', config: PG,
    test: 'database/tests/identityPg.test.js',
    why: 'a VERIFIED Aadhaar row can be deleted, freeing a number that is in use',
    from: `WHERE user_id = $1 AND status = 'FAILED'`,
    to: `WHERE user_id = $1`,
  },
  {
    id: 'M51', file: 'database/repositories/identity.js', config: PG,
    test: 'database/tests/identityPg.test.js',
    why: 'a revoked token becomes valid again once its row expires',
    from: `WHERE token = $1 AND expires_at > now()`,
    to: `WHERE token = $1`,
  },
  // ── The revocation check must never fail open ─────────────────────────────
  {
    id: 'M52', file: 'backend/domains/identity/auth.middleware.js', config: UNIT,
    test: 'backend/tests/unit/tokenRevocationFailsClosed.test.js',
    why: 'a signed-out session stays usable whenever the revocation check breaks',
    from: `    console.error('[auth] revocation check failed — refusing the token:', e.message);
    return true;`,
    to: `    return false;`,
  },
  // ── Money decisions must read the wallet (trap 7) ─────────────────────────
  {
    id: 'M53', file: 'backend/domains/payment/paymentProcessing.service.js', config: UNIT,
    test: 'backend/tests/unit/moneyDecisionsReadTheWallet.test.js',
    why: 'withdrawal admission decided from a record field again — money leaves on this path',
    // The three pre-checks that used to stand here are gone: they raced each
    // other and double-counted the escrow. Admission IS the locked debit now,
    // so the mutation is to put a record-field gate back in FRONT of it.
    from: `  let debitResult;`,
    to: `  if (user.winningsBalance < tokenAmount) throw Object.assign(new Error('Insufficient winnings'), { status: 400 });
  let debitResult;`,
  },
  {
    id: 'M54', file: 'backend/domains/merchant/merchantScoring.service.js', config: UNIT,
    test: 'backend/tests/unit/moneyDecisionsReadTheWallet.test.js',
    why: 'assignment filters candidates on a stored balance, routing orders nobody can fund',
    from: `    candidates = candidates.filter((m) => (availablePaise.get(String(m.merchantId)) ?? -1) >= neededPaise);`,
    to: `    candidates = candidates.filter((m) => m.tokenBalance >= neededPaise);`,
  },
  {
    id: 'M63', file: 'database/repositories/wallets.core.js', config: PG,
    test: 'database/tests/workflowEndToEndPg.test.js',
    why: 'a redelivered refund throws instead of being a no-op — the replay probe is gone',
    from: `  const keys = ledger.map((r) => r.txId);`,
    to: `  const keys = [];`,
  },
  // ── The order-facing wallet writers ───────────────────────────────────────
  {
    id: 'M55', file: 'database/repositories/wallets.js', config: PG,
    test: 'database/tests/walletWriters.test.js',
    why: 'a deposit reserve is credited to the withdrawable pocket instead',
    from: `    userId, field: 'reserveBalance', amount,`,
    to: `    userId, field: 'depositBalance', amount,`,
  },
  {
    id: 'M56', file: 'database/repositories/wallets.js', config: PG,
    test: 'database/tests/walletWriters.test.js',
    why: 'a refund ignores the pocket it was told to credit',
    from: `export async function refundOrder(userId, amount, orderId, field = 'depositBalance') {
  const r = await credit({
    userId, field, amount,`,
    to: `export async function refundOrder(userId, amount, orderId, field = 'depositBalance') {
  const r = await credit({
    userId, field: 'depositBalance', amount,`,
  },
  // ── The three controls that were defined nowhere ─────────────────────────
  {
    id: 'M57', file: 'database/repositories/security.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'expiry is left to a sweep, so a lapsed temporary block still blocks',
    from: `      WHERE ip = $1 AND active AND (expires_at IS NULL OR expires_at > now())`,
    to: `      WHERE ip = $1 AND active`,
  },
  {
    id: 'M58', file: 'database/repositories/security.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'a new block waits out the cache TTL — slow to stop an attacker',
    from: `  // Applied immediately, not at the next TTL: slow to stop an attacker is the
  // expensive direction of this trade.
  invalidateIpCache(ip);
  return rows[0];`,
    to: `  return rows[0];`,
  },
  {
    id: 'M59', file: 'database/repositories/balanceAdjustments.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'the negative-balance guard is lifted, so an admin can debit a pocket below zero',
    from: `      legs: [{ field, deltaPaise: delta }],`,
    to: `      legs: [{ field, deltaPaise: delta }],
      allowNegative: true,`,
  },
  {
    id: 'M60', file: 'database/repositories/balanceAdjustments.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: '`field` is ignored again — every adjustment lands on winnings while the audit row names the pocket the admin asked for',
    from: `    const moved = await applyMovementWithin(ctx, {
      legs: [{ field, deltaPaise: delta }],`,
    to: `    const moved = await applyMovementWithin(ctx, {
      legs: [{ field: 'winningsBalance', deltaPaise: delta }],`,
  },
  {
    id: 'M61', file: 'database/repositories/balanceAdjustments.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'the audit row is written from the caller\'s arguments rather than the locked balance, so a stale `before` can enter the record',
    from: `        amountPaise, beforePaise, beforePaise + delta, String(reason).trim()],`,
    to: `        amountPaise, 0, delta, String(reason).trim()],`,
  },
  {
    id: 'M62', file: 'database/repositories/chat.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'a system notice throws again, so a failed note fails the order it describes',
    from: `  } catch (e) {
    console.error('[chat] system notice not recorded for order', String(orderId), '—', e.message);
    return null;
  }`,
    to: `  } catch (e) {
    throw e;
  }`,
  },

  // ── A merchant cannot close a player's account ────────────────────────────
  // The owner's decision of 2026-09-07, as a mutation. Restoring the risk
  // rules' threshold here is the whole of the old behaviour: a merchant's third
  // unreviewed rejection locks a player out of their own balance.
  {
    id: 'M67', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/merchantRejectPaidRoutes.test.js',
    why: 'a merchant rejection auto-blocks the player again at the risk threshold',
    from: `            maxWarnings: 0,
        });`,
    to: `            maxWarnings: 3,
        });`,
  },
  // ── The review queue is reachable ─────────────────────────────────────────
  // `/users/flagged` below `/users/:userId` resolves to a player whose id is
  // the string "flagged": a 404 the screen renders as its empty state, which is
  // indistinguishable from "nobody is flagged".
  {
    id: 'M68', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/flaggedPlayersRoutes.test.js',
    why: 'the flagged queue is no longer reachable at /users/flagged',
    // NOT a rename of the path to another `/users/:something` — the handler
    // ignores `req.params`, so it would answer just the same and the mutation
    // survives (it did). Taking the path away is what declaring this route
    // BELOW `/users/:userId` actually does: the request falls through to the
    // single-user handler, which 404s on a player called "flagged".
    from: `router.get('/users/flagged', authenticate, isAdminOrSubAdmin, async (req, res) => {`,
    to: `router.get('/users/flagged-unreachable', authenticate, isAdminOrSubAdmin, async (req, res) => {`,
  },
  // ── status and is_blocked cannot come apart ───────────────────────────────
  {
    id: 'M69', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'status stops moving with is_blocked, so sign-in and the guards disagree',
    from: `            status = CASE
              WHEN $2 AND status = 'ACTIVE'  THEN 'BLOCKED'
              WHEN NOT $2 AND status = 'BLOCKED' THEN 'ACTIVE'
              ELSE status END,`,
    to: '',
  },
  // ── The NOT NULL column that 500'd an unblock after it had committed ──────
  {
    id: 'M70', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: "clearing a flag writes NULL into a NOT NULL column and raises 23502 again",
    from: `       payment_flag_reason = '',`,
    to: `       payment_flag_reason = NULL,`,
  },

  // ── A delete must not strand money ────────────────────────────────────────
  // Both guards lived only in a file nothing imported, while a test asserted
  // one of them against that file and passed. They are on the live route now;
  // these are what keep them there.
  {
    id: 'M71', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'a player with a PAID order still open can be deleted again',
    from: `    if (open.total > 0) {`,
    to: `    if (false && open.total > 0) {`,
  },
  {
    id: 'M72', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'a player with money locked in escrow can be deleted again',
    from: `    if (lockedBalance > 0) {`,
    to: `    if (false && lockedBalance > 0) {`,
  },
  // ── The dispute resolution that closed an order and paid nobody ───────────
  // `check:settable` refuses this statically, but a static gate cannot see
  // whether the money moved. This proves the suite does.
  {
    id: 'M73', file: 'backend/domains/payment/paymentOrder.routes.js', config: PG,
    test: 'backend/tests/routes/disputeResolvePathsRoutes.test.js',
    why: 'resolving a dispute marks the order COMPLETED and credits nobody again',
    from: `        disputeDecision:   resolution === 'release' ? 'RELEASE_TO_USER' : 'CANCEL_ORDER',
        disputeResolution: reason.trim(),`,
    to: `        disputeResolution: resolution === 'release' ? 'released' : 'refunded',
        resolutionNotes:   reason.trim(),`,
  },
  {
    id: 'M74', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/disputeResolvePathsRoutes.test.js',
    why: 'a merchant dispute lands DISPUTED with no reason again',
    from: `                disputeRaisedBy: 'merchant',
            },`,
    to: `                disputeRaisedBy: 'merchant',
                updatedAt:       new Date(),
            },`,
  },

  // ── A per-user limiter that counts per IP is not a per-user limiter ───────
  // `req.user.id` does not exist — the repository returns `userId` — so all
  // three of these fell through to the client IP. On CGNAT that throttles
  // strangers together; for anyone willing to change address it is no limit at
  // all, and one of the three guards withdrawals.
  {
    id: 'M75', file: 'backend/middleware/security.js', config: UNIT,
    test: 'backend/tests/unit/rateLimitKeys.test.js',
    why: 'the limiter key reads a field req.user has never had, so it counts per IP again',
    from: `  if (req.user?.userId)   return \`u:\${req.user.userId}\`;`,
    to: `  if (req.user?.id)   return \`u:\${req.user.id}\`;`,
  },
  {
    id: 'M76', file: 'backend/middleware/security.js', config: UNIT,
    test: 'backend/tests/unit/rateLimitKeys.test.js',
    why: 'a pre-session 2FA attempt is keyed on the caller again, so cycling IPs buys guesses',
    from: `  if (req.body?.challengeToken) {`,
    to: `  if (false && req.body?.challengeToken) {`,
  },

  // ── Sign-in is paced, and the refusal says how long ──────────────────────
  {
    id: 'M77', file: 'backend/server.js', config: UNIT,
    test: 'backend/tests/unit/loginPacing.test.js',
    why: 'the admin password path stops being paced',
    from: `app.post('/api/admin/login', loginPaceLimiter, adminAuthLimiter,`,
    to: `app.post('/api/admin/login', adminAuthLimiter,`,
  },
  {
    id: 'M78', file: 'backend/middleware/security.js', config: UNIT,
    test: 'backend/tests/unit/loginPacing.test.js',
    why: 'the pace skips successful attempts, so a first guess is unpaced again',
    from: `        // Every attempt, not only the failures — see above.
        skipSuccessfulRequests: false,`,
    to: `        skipSuccessfulRequests: true,`,
  },
  {
    id: 'M79', file: 'backend/middleware/security.js', config: UNIT,
    test: 'backend/tests/unit/loginPacing.test.js',
    why: 'the refusal drops the absolute instant, so a countdown drifts by the response time',
    from: `            retryAt: resetAt.toISOString(),`,
    to: '',
  },

  // ── The sign-in code is single-use, capped, and bound to one number ───────
  {
    id: 'M80', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramLoginCodePg.test.js',
    why: 'a sign-in code can be redeemed twice, so one code is two sessions',
    from: `        AND code_hash = $2
        AND consumed_at IS NULL
        AND expires_at > now()`,
    to: `        AND code_hash = $2
        AND expires_at > now()`,
  },
  {
    id: 'M81', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramLoginCodePg.test.js',
    why: 'wrong guesses stop being counted, so six digits are guessable again',
    from: `        SET attempts = attempts + 1,`,
    to: `        SET attempts = attempts + 0,`,
  },
  {
    id: 'M82', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramLoginCodePg.test.js',
    why: 'a retired identity answers again, so a code goes to whoever lost the account',
    from: ` ON i.user_id = u.user_id AND i.contact_active`,
    to: ` ON i.user_id = u.user_id`,
  },
  // ── The request endpoint must not reveal whether a number is registered ──
  {
    id: 'M83', file: 'backend/domains/telegram/telegram.routes.js', config: PG,
    test: 'backend/tests/routes/telegramOtpLoginRoutes.test.js',
    why: 'the code request answers differently for an unknown number, so the form becomes an oracle',
    from: `    const { requestLoginCode } = await import('./telegramOtp.service.js');
    await requestLoginCode(req.body?.mobile);`,
    to: `    const { requestLoginCode } = await import('./telegramOtp.service.js');
    const r = await requestLoginCode(req.body?.mobile);
    if (!r.sent) return res.status(404).json({ success: false, message: 'No such number' });`,
  },
  // ── The number typed is the KYC number, never Telegram's own ─────────────
  // `relinkIdentity` rewrites `telegram_identities.phone` during an account
  // recovery and never touches the immutable `users.mobile`. Matching on the
  // identity's phone would let somebody sign in with a number that was never
  // verified against their Aadhaar.
  {
    id: 'M84', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramLoginCodePg.test.js',
    why: 'sign-in matches the Telegram number again, not the KYC-linked mobile',
    from: `(u.mobile, '`,
    to: `(i.phone, '`,
  },
  {
    id: 'M85', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramLoginCodePg.test.js',
    why: 'the linked identity may carry a number that is not the KYC one and still receive the code',
    from: `        AND regexp_replace(i.phone`,
    to: `        AND $1 = $1 OR regexp_replace(i.phone`,
  },
];

// A mutation naming a file or test that no longer exists is not a mutation that
// passed — it is one that never ran. The harness previously reported only what
// it managed to execute, so entries left behind by a refactor quietly reduced
// the coverage this script claims to measure. Refuse to run instead.
const dead = MUTATIONS.filter((m) => !existsSync(m.file) || !existsSync(m.test));
if (dead.length) {
  console.error(`${dead.length} mutation(s) name a file or test that no longer exists:`);
  for (const m of dead) {
    const missing = [!existsSync(m.file) && m.file, !existsSync(m.test) && m.test].filter(Boolean);
    console.error(`  ${m.id}: ${missing.join(', ')}`);
  }
  console.error('\nDelete them, or repoint them at what replaced the behaviour.');
  process.exit(1);
}

// A suite that SKIPS is not a suite that passed. The Postgres suites gate
// themselves on DATABASE_URL (`describePg = pgConfigured() ? describe :
// describe.skip`) and vitest exits 0 when every test in a file is skipped — so
// running a PG mutation without a database reported SURVIVED for a mutation
// that was never executed. That is worse than not running it: it manufactures
// a hole in a suite that does not have one, and the three betPg entries were
// being reported that way for however long DATABASE_URL has been unset here.
const needsPg = MUTATIONS.some((m) => m.config === PG);
if (needsPg && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set, and some mutations run against a real PostgreSQL.');
  console.error('Those suites would SKIP, exit 0, and be reported as SURVIVED — a hole that');
  console.error('does not exist. Set DATABASE_URL, or run `node scripts/mutation-check.mjs unit`.');
  process.exit(1);
}

const only = process.argv[2];
const selected = MUTATIONS.filter((m) => !only
  || (only === 'unit' && m.config === UNIT)
  || (only === 'pg' && m.config === PG)
  || m.id === only);

const results = [];

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ ...m, outcome: 'ANCHOR-MISSING' });
    console.log(`❓ ${m.id}  anchor not found in ${m.file} — mutation could not be applied`);
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let outcome;
  try {
    const out = execSync(`npx vitest run --config ${m.config} ${m.test}`,
      { stdio: 'pipe', env: process.env }).toString();
    // Exit 0 is only evidence of survival if tests actually RAN. A file whose
    // every test skipped also exits 0, and calling that SURVIVED reports a hole
    // in a suite nobody measured.
    outcome = /Tests\s+\d+\s+passed/.test(out) ? 'SURVIVED' : 'NOT-MEASURED';
  } catch {
    outcome = 'KILLED';
  } finally {
    writeFileSync(m.file, original);
  }
  results.push({ ...m, outcome });
  const mark = { KILLED: '✅', SURVIVED: '❌', 'NOT-MEASURED': '❓' }[outcome];
  console.log(`${mark} ${m.id}  ${outcome.padEnd(12)} ${m.why}`);
}

const survived = results.filter((r) => r.outcome === 'SURVIVED');
const unmeasured = results.filter((r) => r.outcome === 'NOT-MEASURED');
const unapplied = results.filter((r) => r.outcome === 'ANCHOR-MISSING');
console.log(`\n${results.filter((r) => r.outcome === 'KILLED').length}/${results.length} mutations killed.`);
if (unmeasured.length) {
  console.log('NOT MEASURED (the suite ran no tests — do not read these as passes):');
  for (const s of unmeasured) console.log(`  ${s.id} ${s.test}`);
}
if (survived.length) {
  console.log('SURVIVED (a hole in the suite):');
  for (const s of survived) console.log(`  ${s.id} ${s.file} — ${s.why}`);
}
// An anchor that no longer matches is a mutation that silently stopped running.
// This used to print and continue, so a rename could retire a check without
// anyone noticing and the run stayed green while measuring less than it claimed
// — 6 of 29 had drifted out this way before it was caught by hand. Retarget the
// anchor at whatever the code became, or delete the entry deliberately.
if (unapplied.length) {
  console.log('ANCHOR MISSING (the mutation never ran — retarget or delete it):');
  for (const s of unapplied) console.log(`  ${s.id} ${s.file} — ${s.why}`);
}
if (survived.length || unmeasured.length || unapplied.length) process.exit(1);

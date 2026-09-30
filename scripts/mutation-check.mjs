// GOVERNANCE: Read CLAUDE.md before editing this file.
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
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    why: 'the manual-assign gate goes back to READING a balance instead of taking the hold, so two admins assigning at once both pass it (F-018)',
    // ── Retargeted 2026-09-16 ────────────────────────────────────────────────
    // The anchor named `const balance = await getMerchantTokenBalance(...)`,
    // and that line is gone because the defect it guarded was fixed properly:
    // `inventoryRefusal` no longer READS a number and let the caller assign in
    // a later statement. It TAKES the hold, and the refusal is the reserve
    // leg's own `UPDATE … WHERE` under the merchant's row lock.
    //
    // So the mutation is now the real regression: put the read back. This is
    // trap 18 — a number read in one statement and acted on in another is a
    // snapshot however good the number is, and this is the one assignment path
    // with no concurrency query behind it.
    from: `  const held = await holdDepositTokens(order, merchantId, { actor });
  if (held.ok) return null;`,
    to: `  const balance = await getSpendablePaiseFor([merchantId]);
  if ((balance.get(String(merchantId))?.spendable ?? 0) >= order.tokenAmount * 100) return null;
  const held = { ok: false, reason: 'insufficient' };`,
  },
  // ── The accounts table: four properties, each verified to be load-bearing ──
  {
    id: 'M43', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'a racing signup on one mobile creates two accounts',
    // Retargeted 2026-09-30: since §33.5 a mobile is unique PER ACCOUNT TYPE,
    // so the conflict target became `(mobile, account_type)` and the old
    // anchor matched nothing. Same guard, same race.
    from: `     ON CONFLICT (mobile, account_type) DO NOTHING\n`,
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
    why: 'a password-reset link can be spent twice, so a link read off a forwarded chat sets a second password on an account that was just reset',
    // Repointed 2026-09-30. It guarded the login TOKEN, deleted with bot
    // sign-in (§33.1); the reset token is the only single-use credential a bot
    // still issues, and no CI tier covered it until this mutant's suite did.
    // M156 (the login CODE) was deleted outright — `code_hash` no longer exists.
    from: `WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    to: `WHERE token_hash = $1 AND expires_at > now()`,
  },
  {
    id: 'M48', file: 'database/repositories/telegram.js', config: PG,
    test: 'database/tests/telegramPg.test.js',
    why: 'an expired reset link stays redeemable until a sweep happens to run',
    // Repointed 2026-09-30. It guarded `telegram_pending_links` (onboarding),
    // deleted with bot signup (§33.1). The property — expiry lives in the
    // WHERE, so a late sweep cannot make a bearer credential usable — now
    // matters on the reset token, which is the only one a bot still issues.
    from: `WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    to: `WHERE token_hash = $1 AND consumed_at IS NULL`,
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
    // other and double-counted the escrow. Admission IS the locked debit now —
    // run once per part, since a cash payout too large for one denomination
    // becomes several ordinary withdrawals — so the mutation is to put a
    // record-field gate back in FRONT of the loop.
    from: `  const created = [];
  let debitResult = null;`,
    to: `  if (user.winningsBalance < tokenAmount) throw Object.assign(new Error('Insufficient winnings'), { status: 400 });
  const created = [];
  let debitResult = null;`,
  },
  {
    id: 'M54', file: 'backend/domains/merchant/merchantScoring.service.js', config: UNIT,
    test: 'backend/tests/unit/moneyDecisionsReadTheWallet.test.js',
    why: 'assignment filters candidates on a stored balance, routing orders nobody can fund',
    // The read moved from `availablePaise` (the available pocket) to
    // `getSpendablePaiseFor` (available MINUS the buy orders already in
    // flight), via a `paiseOf` helper — F-018's more accurate number. The
    // mutation is unchanged in substance: go back to the stored balance on the
    // merchant record, which is the defect this entry names.
    from: `    candidates = candidates.filter((m) => paiseOf(m) >= neededPaise);`,
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
  // ── The controls that were defined nowhere ───────────────────────────────
  // M57/M58 guarded the IP deny-list, removed 2026-09-30 (it never ran).
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
    // `isAdminOrSubAdmin` → `hasPermission('canManageUsers')` (F-001: the gate
    // asks whether you hold the permission, not whether you are staff). The
    // mutation is unchanged in substance — take the path away.
    from: `router.get('/users/flagged', authenticate, hasPermission('canManageUsers'), async (req, res) => {`,
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
    id: 'M74', file: 'backend/domains/payment/payment.routes.js', config: PG,
    test: 'backend/tests/routes/paymentRoutes.test.js',
    why: 'the dispute transition carries a field the order writer refuses, so it throws AFTER the state has already moved — the order is DISPUTED and the handler answers 500',
    // ── Retargeted 2026-09-16 ────────────────────────────────────────────────
    // This named `merchant.routes.js` and a `disputeRaisedBy: 'merchant'`
    // block. There is no such block and no such route: a MERCHANT does not
    // raise disputes on this platform. The player does (here) and the
    // unanswered-PAID sweep does as 'system'. The anchor had been missing for
    // long enough that nobody could say when the route went, which is the cost
    // of a harness that reports NOT-MEASURED and carries on.
    //
    // The SHAPE is kept, because it is the one worth guarding and it is §21's:
    // `setOrderFields` throws on a field name it does not know, and the
    // lifecycle moves the state FIRST — so a bad field in the accompanying
    // write happens after the transition has committed. The order is left
    // DISPUTED, the handler's catch answers 500, and everything it meant to do
    // next never runs. That has shipped three times in three files.
    // Widened to name ONE site. `payment.routes.js` has TWO routes that let a
    // player dispute an order and the `set` block is identical in both, so the
    // narrow anchor mutated whichever came first — trap 13. `disputeReason:
    // reason.trim()` is the line only this one has; the other truncates to
    // 1,000 characters.
    //
    // (That the two exist at all, with different `expectFrom` and different
    // handling of the same field, is its own question — recorded, not fixed
    // here.)
    //
    // Retargeted 2026-09-30: the second dispute route is gone and its 1,000-
    // character cap was carried onto this one, so the anchor now names the
    // only `set` block left. It is unique by construction, not by widening.
    from: `        disputeReason:   reason.trim().slice(0, 1000),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',`,
    to: `        disputeReason:   reason.trim().slice(0, 1000),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',
        updatedAt:       new Date(),`,
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

  // M80-M85 were here — the Telegram sign-in-code mutants (single use, attempt
  // cap, retired identity, number oracle, KYC-number match). Deleted 2026-09-30
  // with the feature: §33.1 removed bot sign-in outright —
  // `telegramOtp.service.js`, `telegram_login_codes` and both suites are gone,
  // and `playerFormAuth.test.js` asserts the table stays gone. Nothing was
  // repointed, because there is no successor: a bot can no longer sign anybody
  // in, so the behaviour these guarded cannot occur. The harness refused to run
  // while they named deleted files, which is how their removal surfaced.
  //
  // What carries over is covered elsewhere: the password login's pacing
  // (M78-M79 above) and the reset token's single use (M47, repointed).

  // M86-M88 were here — the three bulk-payout mutants. Deleted 2026-09-10 with
  // the feature itself: the code they mutate and the suite that killed them are
  // both gone, and a mutation naming a file that no longer exists is what this
  // harness refuses to run with (which is how it caught their removal).
  //
  // Not repointed at anything. The behaviour they guarded — that a batch takes
  // the withdrawal hold, stays scoped to the merchant, and reports a real count
  // — has no successor to point at, because merchants now close payouts one at
  // a time through /confirm/:id, whose own guarantees are covered elsewhere.

  // ── A merchant never learns who the player is ───────────────────────────
  // The projection was a denylist that stripped the player's payout details
  // only on a DEPOSIT, so every WITHDRAWAL carried their UPI ID, and the
  // panel had a render waiting for it.
  {
    id: 'M89', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'the bank object reaches the merchant unfiltered, carrying the player UPI ID again',
    from: `    const bank = bankDetailsFor(plain);`,
    to: `    const bank = plain.userBankDetails;`,
  },
  {
    id: 'M90', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'the allowlist admits the player phone number, which the panel then made searchable',
    from: `  'createdAt', 'updatedAt',
]);`,
    to: `  'createdAt', 'updatedAt', 'userPhone',
]);`,
  },
  {
    id: 'M91', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'a deposit merchant is handed the account the player withdraws to, which is no part of their job',
    from: `  if (type === 'WITHDRAWAL') {`,
    to: `  if (type) {`,
  },

  // ── An order finishes on the rail it was born on ────────────────────────
  // The platform runs one of two P2P rails and an admin switches between them.
  // The orders already in flight must not move with it.
  {
    id: 'M92', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/paymentModeSwitchPg.test.js',
    why: 'the order insert stops stamping the rail, so every order silently takes the column default',
    from: `  const stamp = await stampForNewOrder(paymentMode);`,
    to: `  const stamp = { mode: 'P2P_UPI', version: null };`,
  },
  {
    id: 'M93', file: 'database/repositories/paymentModePolicy.js', config: PG,
    test: 'backend/tests/routes/paymentModeSwitchPg.test.js',
    why: 'a rail switch silently resets every timer an admin tuned back to the column defaults',
    from: `        timers[field] !== undefined ? timers[field] : (previous ? Number(previous[column]) : null)`,
    to: `        timers[field] !== undefined ? timers[field] : null`,
  },
  {
    id: 'M94', file: 'database/schema.sql', config: PG,
    test: 'database/tests/paymentModeImmutabilityPg.test.js',
    why: 'the database stops refusing a rail change, so a future SETTABLE edit could move an in-flight order',
    from: `  IF NEW.payment_mode IS DISTINCT FROM OLD.payment_mode THEN`,
    to: `  IF FALSE THEN`,
  },
  {
    id: 'M95', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/paymentModeRoutes.test.js',
    why: 'the merchant payload is built by spreading the policy row, leaking who switched the rail and why',
    from: `            ...modeCopy(policy?.activeMode),
            timers: publicTimers(policy),`,
    to: `            ...policy,
            ...modeCopy(policy?.activeMode),
            timers: publicTimers(policy),`,
  },
  {
    id: 'M96', file: 'backend/domains/configuration/paymentMode.service.js', config: PG,
    test: 'backend/tests/routes/paymentModeRoutes.test.js',
    why: 'every merchant is interrupted by a timer edit that changes nothing they do',
    from: `  if (railChanged) {`,
    to: `  if (true) {`,
  },
  {
    id: 'M97', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/paymentModeSwitchPg.test.js',
    why: 'the order window follows the rail live NOW, so a mid-flight switch re-deadlines an order under a workflow the player was never shown',
    from: `  const policy = (order?.paymentModeVersion != null`,
    to: `  const policy = (false`,
  },

  // ── One merchant, one denomination ──────────────────────────────────────
  // On the cash rail a merchant stands at an ATM that dispenses one amount.
  // Offering them another is offering an order they physically cannot serve.
  {
    id: 'M98', file: 'backend/domains/merchant/merchantScoring.service.js', config: PG,
    test: 'backend/tests/routes/merchantDenominationsPg.test.js',
    why: 'the selector stops asking for a denomination, so a cash order reaches a merchant at the wrong machine',
    from: `  const cashDenominationPaise = paymentMode === PAYMENT_MODES.CASH_ATM`,
    to: `  const cashDenominationPaise = false && paymentMode === PAYMENT_MODES.CASH_ATM`,
  },
  {
    id: 'M99', file: 'backend/domains/merchant/merchant.admin.routes.js', config: PG,
    test: 'backend/tests/routes/merchantDenominationsPg.test.js',
    why: 'a merchant denomination can be changed while they hold an order, altering the amount they were assigned under',
    from: `      const open = counts.get(String(merchantId))?.total ?? 0;`,
    to: `      const open = 0;`,
  },
  {
    id: 'M100', file: 'backend/domains/merchant/denominations.js', config: PG,
    test: 'backend/tests/routes/merchantDenominationsPg.test.js',
    why: 'a split that cannot be completed returns its partial legs anyway, paying the player LESS than they asked for while reporting success',
    from: `  if (left !== 0) return null;`,
    to: `  if (false) return null;`,
  },

  // ── The ATM cash-link queue ─────────────────────────────────────────────
  // A link is a claim on physical notes about to leave a machine.
  {
    id: 'M101', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'database/tests/cashLinkQueuePg.test.js',
    why: 'the claim matches any denomination at or above the order, so a merchant at a 40,000 machine is handed a 5,000 order',
    // ── Why this mutates the MERCHANT's column and not the link's ───────────
    // The claim tests the denomination TWICE, and they are different
    // questions: `l.denomination_paise` is the size the link was supplied for,
    // `m.cash_denomination_paise` is the tier the merchant is on NOW, re-read
    // because an admin can move them after they supplied it. Both are
    // load-bearing and neither is a duplicate of the other.
    //
    // But it means loosening ONE of them changes no outcome: a merchant and
    // their own link always agree at supply time, so the other condition still
    // refuses and the mutation is unkillable BY CONSTRUCTION. This entry
    // mutated `l.denomination_paise` alone and reported SURVIVED for as long as
    // it has existed — read as a hole in the suite when it was a hole in the
    // mutation. A test was written against it and still could not kill it,
    // which is how the difference showed.
    //
    // Mutating the merchant's condition expresses the behaviour the entry
    // NAMES — "the claim stops matching the size exactly" — because it is the
    // one a claim for a smaller order actually reaches.
    edits: [
      [`            AND l.denomination_paise = $1`, `            AND l.denomination_paise >= $1`],
      [`            AND m.cash_denomination_paise = $1`, `            AND m.cash_denomination_paise >= $1`],
    ],
  },
  {
    id: 'M102', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'database/tests/cashLinkQueuePg.test.js',
    why: 'a link with seconds left is handed to a player who cannot reach the machine but now believes they have been served',
    from: `            AND l.expires_at > now() + make_interval(secs => $2)`,
    to: `            AND l.expires_at > now() + make_interval(secs => $2 * 0)`,
  },
  {
    id: 'M103', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'database/tests/cashLinkQueuePg.test.js',
    why: 'a claim whose order stamp wrote nothing still reports success, marking a link taken by an order that does not know it',
    from: `      if (rowCount !== 1) {`,
    to: `      if (false) {`,
  },
  {
    id: 'M104', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'database/tests/cashLinkQueuePg.test.js',
    why: 'a merchant whose last trip was wasted loses their priority, so the same merchant can be sent out for nothing repeatedly',
    from: `            )) DESC,
            l.expires_at ASC`,
    to: `            )) ASC,
            l.expires_at ASC`,
  },

  // ── What a player may buy, enforced on the server ───────────────────────
  // The player app ships as an APK containing the whole JS bundle, so every
  // one of these is reachable by a hand-made request.
  {
    id: 'M105', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/buyLimitsPg.test.js',
    why: 'the ATM ceiling stops applying, so a hand-made request buys ₹40,000 on the cash rail — a sum no machine dispenses in one go and no cash merchant can serve',
    from: `  if (paymentMode === PAYMENT_MODES.CASH_ATM && paise > MAX_CASH_BUY_PAISE) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M106', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/buyLimitsPg.test.js',
    why: 'any amount is accepted on the cash rail, creating orders no ATM can dispense and no merchant can serve',
    from: `  if (paymentMode === PAYMENT_MODES.CASH_ATM && !isBuyDenomination(paise)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M107', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/buyLimitsPg.test.js',
    why: 'a player opens unlimited simultaneous buys and can occupy several merchants at once during a shortage',
    from: `  if (open > 0) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M108', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/buyLimitsPg.test.js',
    why: 'the buy path stops telling the gate which rail it is on, so the denomination rule silently never fires',
    from: `    paymentMode: railNow.activeMode,`,
    to: `    paymentMode: null,`,
  },
  {
    id: 'M109', file: 'backend/domains/configuration/systemConfigPayload.js', config: UNIT,
    test: 'backend/tests/unit/systemConfigPayload.test.js',
    why: 'the client is told a different set of legal buy amounts than the gate enforces, so the picker offers what the server refuses',
    from: `    buyDenominations:    BUY_DENOMINATIONS_PAISE.map((p) => p / 100),`,
    to: `    buyDenominations:    [100, 200, 300],`,
  },

  // ── The CDM receipt is admin-only ───────────────────────────────────────
  {
    id: 'M110', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'a merchant can attach a CDM receipt to another merchant\'s payout, putting their evidence on somebody else\'s order',
    from: `        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'WITHDRAWAL') {`,
    to: `        const order = await db.orders.getOrderRecord(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'WITHDRAWAL') {`,
  },
  {
    id: 'M111', file: 'backend/domains/disputes/disputeResolution.admin.routes.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'the missing-receipt queue ignores a request for zero minutes and answers a different question during an incident',
    from: `    const olderThanMinutes = Number.isFinite(asked) && asked >= 0 ? asked : 60;`,
    to: `    const olderThanMinutes = asked || 60;`,
  },
  {
    id: 'M112', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'a receipt is reported for an order that has none, so an unevidenced payout reads as evidenced',
    from: `  if (!r || !r.cdm_receipt_url) return null;`,
    to: `  if (!r) return null;`,
  },
  {
    id: 'M113', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'every merchant is shown every other merchant\'s outstanding payouts — order ids, amounts and settlement times for business they have nothing to do with',
    from: `      WHERE merchant_id = $1
        AND order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND cdm_receipt_url IS NULL`,
    to: `      WHERE ($1 IS NOT NULL)
        AND order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND cdm_receipt_url IS NULL`,
  },
  {
    id: 'M114', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'a payout the merchant HAS evidenced never leaves their outstanding list, so the one confirmation they get that a slip landed never comes and they submit it again',
    from: `      WHERE merchant_id = $1
        AND order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND cdm_receipt_url IS NULL
        AND completed_at IS NOT NULL
      ORDER BY completed_at ASC`,
    to: `      WHERE merchant_id = $1
        AND order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND completed_at IS NOT NULL
      ORDER BY completed_at ASC`,
  },
  {
    id: 'M115', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'the outstanding list re-identifies the player it was built to keep out of it, handing the merchant a user id alongside every payout',
    from: `  return rows.map((r) => ({
    orderId: r.order_id,
    fiatAmount: rupees(r.fiat_amount_paise),
    completedAt: r.completed_at,
  }));
}`,
    to: `  return rows.map((r) => ({
    orderId: r.order_id,
    fiatAmount: rupees(r.fiat_amount_paise),
    completedAt: r.completed_at,
    userId: r.order_id,
  }));
}`,
  },
  {
    id: 'M116', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'the merchant panel stops being told which rail an order was born on, so an order held across a rail switch is worked with the wrong process — a UTR asked for on a payout settled at a machine',
    from: `  'paymentMode',`,
    to: ``,
  },

  // ── A cash withdrawal that becomes several withdrawals ──────────────────
  {
    id: 'M117', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/splitWithdrawalPg.test.js',
    why: 'a cash withdrawal is created for an amount no set of denominations can make, so no merchant can ever pay it at a machine and the tokens lock behind an order nobody can serve',
    from: `    const cashParts = splitWithdrawal(fiatPaise);
    if (!cashParts) {`,
    to: `    const cashParts = splitWithdrawal(fiatPaise) ?? [fiatPaise];
    if (false) {`,
  },
  {
    id: 'M118', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/splitWithdrawalPg.test.js',
    why: 'every part debits the WHOLE withdrawal instead of its own share, so a four-part payout locks four times what the player asked to withdraw',
    from: `      debited = await debitWinningsForWithdrawal(String(user.userId), partTokens, partOrderId, { within: insertPart });`,
    to: `      debited = await debitWinningsForWithdrawal(String(user.userId), tokenAmount, partOrderId, { within: insertPart });`,
  },
  {
    id: 'M119', file: 'backend/domains/merchant/denominations.js', config: PG,
    test: 'backend/tests/routes/splitWithdrawalPg.test.js',
    why: 'the payout fee lands on the CASH side, so a part becomes an amount no machine dispenses and no merchant can pay it',
    from: `  const parts = partsPaise.map((paise) => ({
    fiatPaise: Number(paise),
    tokenPaise: Number(paise) + Math.floor((fee * Number(paise)) / cash),
  }));`,
    to: `  const parts = partsPaise.map((paise) => ({
    fiatPaise: Number(paise) - Math.floor((fee * Number(paise)) / cash),
    tokenPaise: Number(paise),
  }));`,
  },
  {
    id: 'M120', file: 'backend/domains/merchant/denominations.js', config: PG,
    test: 'backend/tests/routes/splitWithdrawalPg.test.js',
    why: 'the paise the fee share could not divide evenly are dropped, so the player is charged an amount no row adds up to',
    from: `  const assigned = parts.reduce((sum, p) => sum + p.tokenPaise, 0) - cash;
  parts[0].tokenPaise += fee - assigned;`,
    to: ``,
  },
  {
    id: 'M121', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/splitWithdrawalPg.test.js',
    why: 'the stalled queue stops seeing withdrawals nobody has taken, so a player\'s tokens sit locked with no deadline and nobody accountable for them',
    from: `      WHERE order_type = 'WITHDRAWAL'
        AND state = 'PENDING_QUEUE'
        AND created_at < now() - make_interval(mins => $1)`,
    to: `      WHERE order_type = 'WITHDRAWAL'
        AND state = 'COMPLETED'
        AND created_at < now() - make_interval(mins => $1)`,
  },

  // ── The minute to fetch the UTR ─────────────────────────────────────────
  {
    id: 'M122', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/utrGracePg.test.js',
    why: 'the grace becomes repeatable, so a player taps every fifty seconds and holds a merchant\'s capacity open indefinitely — a denial of service against the queue wearing the shape of a courtesy',
    from: `        AND utr_grace_at IS NULL
        AND state IN ('ASSIGNED', 'PROCESSING')`,
    to: `        AND state IN ('ASSIGNED', 'PROCESSING')`,
  },
  {
    id: 'M123', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/utrGracePg.test.js',
    why: 'the grace SHORTENS a deadline that was further out, so an order with ten minutes left is cut to one at the moment the player starts typing',
    from: `            expires_at   = GREATEST(COALESCE(expires_at, now()), now() + make_interval(secs => $3)),`,
    to: `            expires_at   = now() + make_interval(secs => $3),`,
  },
  {
    id: 'M124', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/utrGracePg.test.js',
    why: 'the window stops coming from the policy, so the number an admin edits on the settlement screen decides nothing again',
    from: `  const graceSeconds = policy?.utrSubmitSeconds ?? 60;`,
    to: `  const graceSeconds = 60;`,
  },
  {
    id: 'M125', file: 'database/repositories/paymentModePolicy.js', config: PG,
    test: 'backend/tests/routes/paymentModeSwitchPg.test.js',
    why: 'a timer passed at the top level is silently discarded and the publish reports success — an operator sets a window, is told it worked, and the old value stays live',
    from: `  const stray = Object.keys(unknown);
  if (stray.length) {`,
    to: `  const stray = [];
  if (stray.length) {`,
  },

  // ── Retry, and the link that arrives late ───────────────────────────────
  {
    id: 'M126', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'a supplied link is never handed to an order already waiting, so a player watches a live order expire while a merchant stands at a machine with a link nobody takes',
    from: `  const waiting = await db.orders.ordersAwaitingCashLink({ limit });`,
    to: `  const waiting = [];`,
  },
  {
    id: 'M127', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'the queue stops ranking retries first, so a player who already waited and got nothing goes to the back of the queue that failed them',
    from: `      ORDER BY assignment_priority DESC, created_at ASC`,
    to: `      ORDER BY created_at ASC`,
  },
  {
    id: 'M128', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'an order that already holds a link stays in the waiting queue, so it is handed a second one and the first is stranded until it expires',
    from: `        AND cash_link_id IS NULL
      ORDER BY assignment_priority DESC`,
    to: `      ORDER BY assignment_priority DESC`,
  },
  {
    id: 'M129', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'an order that is still live can be retried, so a player gets a second order for money already in flight — two merchants on a buy, and on a sell their tokens locked twice',
    from: `  const retryable = ['CANCELLED', 'FAILED', 'REJECTED'].includes(original.status);`,
    to: `  const retryable = true;`,
  },
  {
    id: 'M130', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'a retry is created at ordinary rank, so the whole point of retrying — going before the first-time orders — silently does not happen',
    from: `  const attempt = { priority: 1, retryOf: original.orderId };`,
    to: `  const attempt = { priority: 0, retryOf: original.orderId };`,
  },
  {
    id: 'M131', file: 'backend/domains/merchant/cashLink.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'a merchant supplies a new link while already working an order, so supply-claim-supply gives one merchant unbounded concurrent orders on a rail whose cap is ONE — the cash-link claim never goes through the scorer, so nothing else checks it',
    from: `  if (open >= cap) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M132', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'a claim whose order will not move is left standing, so the link is consumed and the order holds a link id while still queued — the link out of the queue so no merchant can be sent with it, the order showing a payment link nobody is working',
    // Widened to name ONE site. The same release appears twice in this file —
    // once when the HOLD fails and once when the transition does — and the
    // narrow anchor mutated whichever came first, so the verdict described a
    // different defect from the one this entry names (trap 13). The comment
    // above the first one is what only it has.
    from: `      // The link is given back for the same reason as below: it was claimed
      // before this could fail, and a consumed link on an unassigned order is
      // two people waiting on nothing.
      await db.cashLinks.releaseClaim({ linkId: claim.link.linkId, orderId: order.orderId })`,
    to: `      await Promise.resolve({ ok: true })`,
  },
  {
    id: 'M133', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'a release can pull a link out from under an order that IS being served — a player mid-payment loses the link they were sent to pay',
    from: `        WHERE link_id = $1 AND claimed_by_order = $2 AND status = 'CLAIMED'`,
    to: `        WHERE link_id = $1 AND status = 'CLAIMED'`,
  },
  {
    id: 'M134', file: 'database/repositories/cashLinks.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'the released link is put back without clearing the order, so the order looks served by a link that has gone to somebody else',
    from: `    await client.query(
      \`UPDATE order_states SET cash_link_id = NULL, updated_at = now()
        WHERE order_id = $1 AND cash_link_id = $2\`,
      [String(orderId), String(linkId)],
    );`,
    to: ``,
  },
  {
    id: 'M135', file: 'database/repositories/paymentModePolicy.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'the cash rail takes its concurrency from the policy column again, which defaults to 3 and is carried across a rail switch — so a merchant at a machine is promised out three times over the same notes',
    from: `  if (policy?.activeMode === PAYMENT_MODES.CASH_ATM) return 1;`,
    to: ``,
  },
  {
    id: 'M136', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/assignmentWindowPg.test.js',
    why: 'an order no merchant ever took is never expired — creation sets no deadline, so it waits forever and a withdrawal\'s escrow locks a player\'s money with nothing scheduled to release it',
    from: `              OR (o.expires_at IS NULL
                  AND o.state = 'PENDING_QUEUE'
                  AND o.created_at < now() - make_interval(
                        secs => COALESCE(p.assignment_wait_seconds, $2)))`,
    to: ``,
  },
  {
    id: 'M137', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/assignmentWindowPg.test.js',
    why: 'an order is swept the moment it is created, so a buy a merchant was about to take is cancelled out from under both of them',
    from: `                  AND o.created_at < now() - make_interval(
                        secs => COALESCE(p.assignment_wait_seconds, $2)))`,
    to: `                  )`,
  },

  // ── A1: a player sees where to pay, not who they are paying ───────────────
  {
    id: 'M138', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the projection passes the merchant snapshot through whole, so every player receives the merchant UPI handle, QR, bank account, IFSC and account-holder name',
    from: `  const counterparty = counterpartyFor(plain);
  if (counterparty) view.payTo = counterparty;`,
    to: `  if (plain.merchantSnapshot) view.merchantSnapshot = plain.merchantSnapshot;`,
  },
  {
    id: 'M139', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'payTo carries the whole snapshot rather than the fields it may — the leak in its subtlest form, a projection that projects nothing',
    // Anchored on the FIRST line of the projection plus the guard clause above
    // it, not on the whole body: the body grew a USDT branch and this entry
    // silently stopped applying — it was reported as ANCHOR MISSING for the
    // first time only after the harness started failing on that.
    from: `  const view = {};
  // Built at assignment by \`buildMerchantSnapshot\`, from the merchant's own`,
    to: `  return { ...snapshot };
  // eslint-disable-next-line no-unreachable
  const view = {};
  // Built at assignment by \`buildMerchantSnapshot\`, from the merchant's own`,
  },
  {
    id: 'M140', file: 'backend/domains/payment/payment.routes.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the status poll — the response that fires most often, every few seconds while a player waits — stops projecting and pushes the merchant credentials again',
    from: `      payTo:           view.payTo ?? null,`,
    to: `      payTo:           order.merchantSnapshot,`,
  },
  {
    id: 'M141', file: 'backend/domains/payment/paymentLink.js', config: UNIT,
    test: 'backend/tests/unit/paymentLink.test.js',
    why: 'an empty payee builds `upi://pay?pa=` and the screen renders a live button to a payment that goes nowhere recoverable',
    from: `  if (!payee || !Number.isFinite(amount) || amount <= 0) return null;`,
    to: `  if (false) return null;`,
  },
  // ── B7: the USDT merchant rail, and one payment claimed once ─────────────
  {
    id: 'M143', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'the chain filter goes, so a USDT order is offered to a merchant with no address on that network — the player sends to a chain the address does not exist on and the tokens are gone',
    // The anchor is the CLAUSE inside the interpolation, not the interpolation
    // itself: `${…}` inside a mutation's own template literal is evaluated by
    // this file rather than matched, so an anchor containing one never matches
    // and the mutation reports NOT MEASURED — a hole in the suite that reads
    // like a hole in the code.
    from: `AND m.` + `$` + `{chainColumn} IS NOT NULL`,
    to: `AND TRUE`,
  },
  {
    id: 'M144', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'an unknown chain matches nobody SILENTLY instead of throwing, which reads on a screen as "no merchant is available" and has a player wait through a malformed request',
    from: `    if (!chainColumn) {
      throw new TypeError(\`assignmentCandidates: unknown usdtChain '\${usdtChain}'\`);
    }`,
    to: `    if (!chainColumn) { chainColumn = null; }`,
  },
  {
    id: 'M145', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'a USDT buy with no chain is admitted, so it matches no merchant and sits in the queue until it expires while the screen says "waiting for a merchant"',
    from: `  if (currency === MERCHANT_CURRENCY.USDT && !isUsdtChain(usdtChain)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M146', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'any size is accepted on the USDT rail, so the three fixed token denominations stop being fixed and a merchant is asked for a sum they never agreed to serve',
    from: `    if (!isUsdtBuyDenomination(paise)) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M147', file: 'backend/domains/payment/paymentReference.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'the registry refusal is swallowed, so one real payment can be claimed on two orders — the defect this whole registry exists to prevent',
    from: `  if (!claimed.ok) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M148', file: 'backend/domains/payment/paymentReference.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'a transaction id of any shape is accepted, so a bank UTR or a hash from the wrong chain is taken as proof of a payment nobody can find',
    from: `  if (!normalized || !spec.valid(normalized)) {`,
    to: `  if (!normalized) {`,
  },
  {
    id: 'M149', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the player is handed the merchant’s address for BOTH chains instead of the one their own order named, so half of them send on a network that address does not exist on',
    from: `  if (snapshot.usdtPayTo && snapshot.usdtChain) {
    view.usdtAddress = snapshot.usdtPayTo;`,
    to: `  if (snapshot.usdtAddressTrc20 || snapshot.usdtAddressBep20) {
    view.usdtAddress = snapshot.usdtAddressTrc20 || snapshot.usdtAddressBep20;
    view.usdtAddressBep20 = snapshot.usdtAddressBep20;`,
  },
  {
    id: 'M150', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'the CDM slip’s bank reference is recorded and never claimed, so one cash deposit can be presented as proof of two payouts',
    from: `            await claimPaymentReference({
                reference: transactionId,`,
    to: `            await Promise.resolve({
                reference: transactionId,`,
  },
  {
    id: 'M151', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/merchantPanelRoutes.test.js',
    why: 'a merchant may accept a USDT order on a chain they hold no address for, so the player is shown nothing to send to — or worse, the other chain’s address',
    from: `            if (!usdtAddressFor(merchant, chain)) {`,
    to: `            if (false) {`,
  },
  {
    id: 'M152', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'a USDT purchase with no rate set is priced at the INR peg instead of refused, so 50,000 tokens are sold for 50,000 USDT and a player might take it',
    from: `    if (quoted === null || rate === null) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M153', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'the USDT figure stops coming from the rate, so the player is asked to send one USDT per token — the quote and the tokens become the same number',
    from: `    fiatAmount = quoted;`,
    to: `    fiatAmount = tokenAmount;`,
  },
  {
    id: 'M154', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'assignment re-reads the rate minutes after the player agreed to a price, so an admin edit in between re-prices a purchase already made — and, with the row frozen, leaves the order unassignable instead',
    from: `  const rateUsed = order.rateUsed ?? rateForMerchant(merchant, await getSystemConfig());`,
    to: `  const rateUsed = rateForMerchant(merchant, await getSystemConfig());`,
  },
  {
    id: 'M155', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/cdmReceiptRoutes.test.js',
    why: 'the CDM receipt handler reads the order unscoped, so ANY merchant can attach their slip to ANY payout — claiming somebody else’s cash deposit and the evidence a dispute is decided on',
    from: `        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'WITHDRAWAL') {`,
    to: `        const order = await db.orders.getOrderRecord(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'WITHDRAWAL') {`,
  },
  {
    id: 'M142', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'the merchant projection returns the order untouched, so the player phone number and UPI id ride along on every merchant response',
    from: `  const view = {};
  for (const key of MERCHANT_ORDER_FIELDS) {
    if (plain[key] !== undefined) view[key] = plain[key];
  }`,
    to: `  const view = { ...plain };`,
  },

  // ── The order tamper tag is written, and a missing one is refused ───────
  // Both halves were missing at once: the only writer of `order_hmac` was a
  // creation path production never called, and the guard waved an untagged
  // order through. Every test of the tag produced its tag by WRITING one.
  {
    id: 'M156', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/orderAccessGuardRoutes.test.js',
    why: 'the one order insert stops writing the tamper tag, so every live order is untagged and the guard mounted on every order route checks nothing',
    from: `    stamp.mode, stamp.version, usdtChain, deriveOrderHmac(orderId)];`,
    to: `    stamp.mode, stamp.version, usdtChain, null];`,
  },
  {
    id: 'M165', file: 'backend/middleware/order-crypto-access.js', config: PG,
    test: 'backend/tests/routes/orderAccessGuardRoutes.test.js',
    why: 'the guard passes an order whose tag was stripped, so a row inserted outside the system is served as if it were ours',
    from: `    if (order.orderHmac ? !verifyOrderHmac(order.orderId, order.orderHmac) : orderTaggingConfigured()) {`,
    to: `    if (order.orderHmac ? !verifyOrderHmac(order.orderId, order.orderHmac) : false) {`,
  },

  // ── A buy's merchant side is taken ONCE, from the hold ──────────────────
  // The confirm route dispensed the hold (reserved -a) and `moveDepositMoney`
  // debited `available -a` as well: every confirmed buy cost the merchant
  // twice, and a merchant whose tokens were all held for the order was refused
  // after the hold was spent. The four other completion doors never dispensed.
  {
    id: 'M167', file: 'backend/domains/payment/depositCredit.js', config: PG,
    test: 'backend/tests/routes/depositConfirmConservationPg.test.js',
    why: 'the buy charges `available` even when its hold already paid for it, so the merchant pays twice and a fully-held merchant can never confirm',
    from: `  if (fromHold.noHold) {`,
    to: `  if (true) {`,
  },
  {
    id: 'M168', file: 'backend/domains/merchant/depositEscrow.service.js', config: PG,
    test: 'backend/tests/routes/depositConfirmConservationPg.test.js',
    why: 'a retried confirm reads a spent hold as "never held" and takes the tokens again from `available`',
    from: `    if (await dispensedDepositSettlementFor(order.orderId, merchantId)) {
      return { ok: true, alreadyTaken: true };
    }`,
    to: `    if (false) {
      return { ok: true, alreadyTaken: true };
    }`,
  },

  // ── An admin ends a withdrawal through ONE owner ────────────────────────
  // Ten of eleven route × money-position cells were wrong: refunds credited
  // winnings and left the lock, releases moved nothing, a HELD settlement was
  // stranded, and a refunded dispute was written back to DISPUTED.
  {
    id: 'M169', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'an admin refund never takes the stake out of the lock, so the player holds the amount twice and the token total no longer adds up',
    from: `  if (settlement || order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }`,
    to: `  if (false) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }`,
  },
  {
    id: 'M170', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'an admin release credits the merchant while the stake stays locked for good — the player keeps what the merchant was paid for',
    from: `      await releaseWithdrawal(order.userId, order.tokenAmount, order.orderId);
    } catch (err) {
      // The same compensation \`settleHold\` makes, for the same reason.`,
    to: `      void 0;
    } catch (err) {
      // The same compensation \`settleHold\` makes, for the same reason.`,
  },
  {
    id: 'M171', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'the settlement mirror writes the order state behind the route, so a refunded dispute is written back to DISPUTED and returns to the queue',
    from: `  if (keepState) OUTCOME.state = null;`,
    to: `  if (false) OUTCOME.state = null;`,
  },
  {
    id: 'M172', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'with the hold disabled the confirm never settles, so the merchant who paid is not credited until a sweep that may be minutes away',
    from: `            if (holdFor === 0) {`,
    to: `            if (false) {`,
  },

  // ── An assertion comparing NaN with NaN is refused ──────────────────────
  // Two such assertions (wrong keys, undefined → NaN, Object.is(NaN, NaN)) hid
  // the buy double charge (F-026) for as long as they existed.
  {
    id: 'M173', file: 'backend/tests/assertionGuards.setup.js', config: UNIT,
    test: 'backend/tests/unit/assertionGuards.test.js',
    why: 'the test-setup guard stops refusing NaN-versus-NaN, so an assertion reading a key that does not exist passes for any value again',
    from: `const bothNaN = (a, b) => typeof a === 'number' && typeof b === 'number'
  && Number.isNaN(a) && Number.isNaN(b);`,
    to: `const bothNaN = () => false;`,
  },

  // ── A withdrawal's lock and its order commit together ───────────────────
  // They were two commits, and the second could be refused: a second retry of
  // one expired withdrawal collides on `retry_of_order_id` AT INSERT, after the
  // winnings were already locked, stranding them against an order that never
  // existed. The INSERT now runs inside the debit's own transaction.
  {
    id: 'M166', file: 'database/repositories/wallets.js', config: PG,
    test: 'backend/tests/routes/withdrawalRetryPg.test.js',
    why: 'the withdrawal lock commits without waiting for its order, so a refused INSERT leaves winnings locked against an order that does not exist — and nothing ever releases them',
    // The mutant still writes the order — AFTER the lock has committed, on a
    // separate connection. That is exactly the two-commit shape this entry
    // exists to catch, restored.
    edits: [
      [`    const record = within ? await within(ctx.client) : null;
    return { commit: true, value: { ...moved, record } };`,
       `    return { commit: true, value: { ...moved, record: null, pending: within } };`],
      [`  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    // A refusal here is an EXPECTED answer, not a fault: the player asked for`,
       `  if (result.idempotent) return { idempotent: true, txId };
  if (result.ok && result.pending) {
    const { getPool } = await import('../client.js');
    const client = await (await getPool()).connect();
    try { result.record = await result.pending(client); } finally { client.release(); }
  }
  if (!result.ok) {
    // A refusal here is an EXPECTED answer, not a fault: the player asked for`],
    ],
  },
  {
    id: 'M157', file: 'database/repositories/casino.js', config: PG,
    test: 'database/tests/casinoSessionBindingPg.test.js',
    why: 'a signed provider BET debits whichever player the payload names, with no session that player opened, so a forged or leaked launch token bets with somebody else\'s balance',
    from: `  if (normalised === 'BET') {`,
    to: `  if (false && normalised === 'BET') {`,
  },
  {
    id: 'M158', file: 'backend/domains/identity/fieldCrypto.util.js', config: UNIT,
    test: 'backend/tests/unit/fieldCryptoRotation.test.js',
    why: 'identity decryption accepts a truncated GCM tag, so a forged Aadhaar/identity ciphertext needs ~2^32 tries instead of 2^128',
    from: `Buffer.from(iv, 'base64'), GCM_TAG);`,
    to: `Buffer.from(iv, 'base64'));`,
  },
  {
    id: 'M159', file: 'backend/domains/identity/totp.service.js', config: UNIT,
    test: 'backend/tests/unit/totp.service.test.js',
    why: 'a stored 2FA secret decrypts under a truncated GCM tag, so the tag authenticates 4 bytes instead of 16',
    from: `Buffer.from(iv, 'base64'), GCM_TAG);`,
    to: `Buffer.from(iv, 'base64'));`,
  },
  // ── Android releases (2026-09-30) ───────────────────────────────────────────
  {
    id: 'M160', file: 'database/repositories/androidReleases.js', config: PG,
    test: 'backend/tests/routes/androidReleaseRoutes.test.js',
    why: 'a draft publishes below a release already published, so every phone is offered a DOWNGRADE Android refuses — an update screen that loops for ever',
    from: `                             AND p.published_at IS NOT NULL AND p.version_code >= r.version_code)`,
    to: `                             AND false)`,
  },
  {
    id: 'M161', file: 'backend/domains/distribution/androidRelease.admin.routes.js', config: PG,
    test: 'backend/tests/routes/androidReleaseRoutes.test.js',
    why: 'an APK signed with a different key than the installed app is accepted and published, and every phone refuses it as an update',
    from: `if (latest && latest.signerSha256 !== info.signerSha256) {`,
    to: `if (false && latest && latest.signerSha256 !== info.signerSha256) {`,
  },
  {
    id: 'M162', file: 'backend/domains/distribution/androidRelease.admin.routes.js', config: PG,
    test: 'backend/tests/routes/androidReleaseRoutes.test.js',
    why: 'a debug-signed build is published; no release install can ever update from it',
    from: `if (info.debugSigned) {`,
    to: `if (false && info.debugSigned) {`,
  },
  {
    id: 'M163', file: 'backend/domains/distribution/androidRelease.shared.js', config: UNIT,
    test: 'backend/tests/unit/androidUpdateStatus.test.js',
    why: 'an install below a MANDATORY release is only offered the update, so an operator forcing a security fix blocks nobody',
    from: `if (installedCode < policy.minRequiredVersionCode) return 'required';`,
    to: `if (installedCode < policy.minRequiredVersionCode) return 'available';`,
  },
  {
    id: 'M164', file: 'database/repositories/androidReleases.js', config: PG,
    test: 'backend/tests/routes/androidReleaseRoutes.test.js',
    why: 'a draft signed with a different key publishes — legal at upload while nothing was published — and every phone refuses the update',
    from: `                             AND k.published_at IS NOT NULL AND k.signer_sha256 <> r.signer_sha256)`,
    to: `                             AND false)`,
  },
  // ── An undeclared config key is the CALLER's mistake (B3, 2026-09-30) ────
  {
    id: 'M174', file: 'database/repositories/config.js', config: PG,
    test: 'backend/tests/routes/configRefusalRoutes.test.js',
    why: 'the undeclared-key refusal loses its status, so an admin typo on the branding or support-links screen answers "Something went wrong" and hides the key it named',
    from: `      throw invalidConfig(
        \`config: refusing to write undeclared setting`,
    to: `      throw new Error(
        \`config: refusing to write undeclared setting`,
  },
  // ── A blank-looking reason is the admin's mistake (B3 sweep, 2026-09-30) ──
  // Each route tested `!reason` while its writer requires `reason.trim()`, so a
  // reason of spaces passed the route and the writer's bare Error became a 500.
  {
    id: 'M175', file: 'backend/routes/retention.routes.js', config: PG,
    test: 'backend/tests/routes/adminBalanceAdjustRoutes.test.js',
    why: 'a reason of spaces passes the balance-adjust route and the writer throws it back as a 500',
    from: `if (!userId || !type || !field || !amount || !String(reason ?? '').trim()) {`,
    to: `if (!userId || !type || !field || !amount || !reason) {`,
  },
  {
    id: 'M176', file: 'backend/domains/merchant/merchant.admin.routes.js', config: PG,
    test: 'backend/tests/routes/merchantAdminRoutes.test.js',
    why: 'a rejection reason of spaces passes the route and rejectMerchant throws it back as a 500',
    from: `if (!String(reason ?? '').trim()) return res.status(400).json({ success: false, message: 'Rejection reason is required' });`,
    to: `if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });`,
  },
  // ── A dispute that races the hold worker (review C3, 2026-09-30) ─────────
  {
    id: 'M177', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/disputeSettleRacePg.test.js',
    why: 'the worker settles on a snapshot of the order: a dispute raised after the read is settled underneath, stake consumed and merchant credited',
    from: `    orderStateIn: ['PAID'],
  });`,
    to: `  });`,
  },
  {
    id: 'M178', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeSettleRacePg.test.js',
    why: 'the settlement mirror writes COMPLETED over a dispute raised after the settlement committed, taking it out of the queue with nobody told',
    from: `state = CASE WHEN $4::text IS NOT NULL AND state = 'PAID' THEN $4 ELSE state END,`,
    to: `state = COALESCE($4, state),`,
  },
  // ── The cash matcher follows the ORDER's rail (review C2, 2026-09-30) ────
  {
    id: 'M179', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/cashLinkRoutes.test.js',
    why: 'the matcher branches on the rail in force, so a switch to UPI strands every cash buy already waiting and every link already supplied for them',
    from: `  const waiting = await db.orders.ordersAwaitingCashLink({ limit });`,
    to: `  const rail = await getActivePaymentModePolicy();
  if (rail?.activeMode !== PAYMENT_MODES.CASH_ATM) return { matched: 0, considered: 0 };
  const waiting = await db.orders.ordersAwaitingCashLink({ limit });`,
  },
  // ── An order is stamped with the rail it was validated for (review C1) ───
  {
    id: 'M180', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/railSnapshotPg.test.js',
    why: 'the buy is stamped by a second read of the rail, so an admin switch in between births an order on a rail its amount was never checked for',
    from: `    railPolicy:        railNow,
`,
    to: ``,
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

/**
 * What the run actually measured, from vitest's own JSON.
 *
 * Three outcomes, and the distinction between the last two is the point:
 *
 *   KILLED       tests ran and at least one failed — the suite noticed.
 *   SURVIVED     tests ran, all passed — a hole.
 *   NOT-MEASURED nothing ran. Neither evidence of a hole nor of coverage.
 *
 * A non-zero exit is NOT enough to call a mutation killed. A mutant that makes
 * the module unparseable, or a filter that matches no file, also exits non-zero
 * — and counting those as killed is the exact mirror of the bug the
 * NOT-MEASURED check exists to prevent: a mutation credited to a suite that
 * never ran a line of it.
 */
function verdictFrom(reportPath, exit) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    // No report at all: vitest died before it could write one. That is not a
    // measurement either way, whatever the exit code was.
    return 'NOT-MEASURED';
  }
  const ran = Number(report.numTotalTests ?? 0) - Number(report.numPendingTests ?? 0);
  if (ran <= 0) return 'NOT-MEASURED';
  if (Number(report.numFailedTests ?? 0) > 0) return 'KILLED';
  // Tests ran and none failed. On a non-zero exit that means the failure was
  // outside the tests — an unhandled rejection, a teardown throw — which the
  // suite did notice, so it counts.
  return exit === 'exit-0' ? 'SURVIVED' : 'KILLED';
}

const results = [];

/**
 * The edits one mutation makes, as `[from, to]` pairs.
 *
 * ── Why a mutation may need more than one ──────────────────────────────────
 * Some behaviour is enforced in two places ON PURPOSE, and then loosening
 * either one alone changes no outcome — the other still refuses, the mutant
 * behaves exactly like the original, and the entry reports SURVIVED forever.
 * That reads as a hole in the suite when it is a hole in the MUTATION, and it
 * is the more expensive of the two mistakes because the fix people reach for is
 * writing a test that cannot possibly pass.
 *
 * M101 is the case that showed it. The cash-link claim tests the denomination
 * twice — `l.denomination_paise`, the size the link was supplied for, and
 * `m.cash_denomination_paise`, the tier the merchant is on now — and both are
 * load-bearing, because an admin can move a merchant between the two moments. A
 * mutation of either one is unkillable by construction, and a test was written
 * against it and still could not kill it, which is how the difference showed.
 *
 * So `edits` expresses "this BEHAVIOUR stops holding", which is what a mutation
 * is supposed to say. Every pair is still checked for presence and for
 * ambiguity individually, so the multi-site form loosens nothing.
 */
const editsOf = (m) => (m.edits ?? [[m.from, m.to]]);

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8');
  const edits = editsOf(m);
  const missing = edits.find(([from]) => !original.includes(from));
  if (missing) {
    results.push({ ...m, outcome: 'ANCHOR-MISSING' });
    console.log(`❓ ${m.id}  anchor not found in ${m.file} — mutation could not be applied`);
    continue;
  }
  // ── An anchor that matches twice mutates the wrong place ────────────────
  // `String.replace(string, …)` changes the FIRST occurrence only. So an
  // anchor like `getMerchantOrder(req.params.id, req.merchantId)` — which
  // appears five times in one router — silently mutates whichever call site
  // comes first, and the verdict then describes a defect somewhere other than
  // the one the entry names. A KILLED for the wrong reason is worse than a
  // SURVIVED, because nobody looks at it again.
  //
  // Checked per EDIT, not per mutation: a multi-site mutation is several
  // unambiguous anchors, never one ambiguous one.
  const ambiguous = edits.find(([from]) => original.indexOf(from) !== original.lastIndexOf(from));
  if (ambiguous) {
    results.push({ ...m, outcome: 'ANCHOR-AMBIGUOUS' });
    console.log(`❓ ${m.id}  anchor appears more than once in ${m.file} — widen it so it names ONE site`);
    continue;
  }
  writeFileSync(m.file, edits.reduce((text, [from, to]) => text.replace(from, to), original));
  let outcome;
  const report = join(tmpdir(), `mutation-${m.id}.json`);
  try { rmSync(report, { force: true }); } catch { /* first run */ }
  try {
    // ── The verdict is read from DATA, never from printed prose ────────────
    //
    // This decided by regexing vitest's summary line out of stdout. That line
    // is prose: its wording depends on the reporter, its colour codes sit
    // between the words the pattern needs adjacent, and which stream it lands
    // on depends on whether the runner looks like a terminal.
    //
    // It cost a CI round trip. M49 measured 22 tests on every local run and
    // came back NOT MEASURED in CI, on a check that had been green for weeks —
    // the tests ran, the summary simply did not read the way the pattern
    // expected there. A money suite reported as unmeasured when it measured is
    // the same class of wrong as one reported as passing when it did not run.
    //
    // `--reporter=json` writes a file with counts in it. Both streams are still
    // piped so nothing depends on which one vitest chooses.
    execSync(`npx vitest run --config ${m.config} ${m.test} --reporter=json --outputFile=${report}`,
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    outcome = verdictFrom(report, 'exit-0');
  } catch {
    outcome = verdictFrom(report, 'exit-nonzero');
  } finally {
    writeFileSync(m.file, original);
    try { rmSync(report, { force: true }); } catch { /* nothing to clean */ }
  }
  results.push({ ...m, outcome });
  const mark = { KILLED: '✅', SURVIVED: '❌', 'NOT-MEASURED': '❓' }[outcome];
  console.log(`${mark} ${m.id}  ${outcome.padEnd(12)} ${m.why}`);
}

const survived = results.filter((r) => r.outcome === 'SURVIVED');
const unmeasured = results.filter((r) => r.outcome === 'NOT-MEASURED');
const unapplied = results.filter((r) => r.outcome === 'ANCHOR-MISSING');
const ambiguous = results.filter((r) => r.outcome === 'ANCHOR-AMBIGUOUS');
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
// An anchor matching twice does not fail to run — it runs somewhere ELSE, and
// reports a verdict about a site the entry never named.
if (ambiguous.length) {
  console.log('ANCHOR AMBIGUOUS (it names more than one site — widen it):');
  for (const s of ambiguous) console.log(`  ${s.id} ${s.file} — ${s.why}`);
}
if (survived.length || unmeasured.length || unapplied.length || ambiguous.length) process.exit(1);

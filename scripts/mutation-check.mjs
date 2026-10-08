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
    // Retargeted 2026-10-07 (the conservation guards): the split, the credit
    // and the pool spend are ONE transaction, so the pairing is no longer two
    // calls that could disagree — it is the database's rule. Crediting more
    // than the pool parts with does not commit at all.
    id: 'M22', file: 'database/repositories/wallets.js', config: PG,
    test: 'database/tests/depositConservationPg.test.js',
    why: 'the player is credited the whole amount AND the reserve share while the pool parts with the total once: tokens created',
    from: `    { field: 'depositBalance', amountPaise: split.depositPaise, txId: \`dep_complete_\${orderId}\`, reason: \`P2P deposit confirmed \${orderId}\` },`,
    to: `    { field: 'depositBalance', amountPaise: Number(amountPaise), txId: \`dep_complete_\${orderId}\`, reason: \`P2P deposit confirmed \${orderId}\` },`,
  },
  {
    id: 'M23', file: 'database/repositories/wallets.js', config: UNIT,
    test: 'backend/tests/unit/buyCreditSplit.test.js',
    why: 'the `||` fallback is back — a legal 0 deposit share reads as absent',
    from: `  if (!usable) return { depositPaise: total, reservePaise: 0, split: false };
  return { depositPaise: deposit, reservePaise: reserve, split: true };`,
    to: `  if (!usable) return { depositPaise: total, reservePaise: 0, split: false };
  return { depositPaise: deposit || total, reservePaise: reserve, split: true };`,
  },
  {
    id: 'M24', file: 'database/repositories/wallets.js', config: UNIT,
    test: 'backend/tests/unit/buyCreditSplit.test.js',
    why: 'a partial split is accepted, so part of the deposit goes unaccounted for',
    from: `    && deposit + reserve === total;`,
    to: `    && true;`,
  },
  {
    id: 'M25', file: 'database/repositories/wallets.js', config: UNIT,
    test: 'backend/tests/unit/buyCreditSplit.test.js',
    why: 'the fallback credits nothing instead of the whole amount — tokens burned',
    from: `  if (!usable) return { depositPaise: total, reservePaise: 0, split: false };`,
    to: `  if (!usable) return { depositPaise: 0, reservePaise: 0, split: false };`,
  },
  {
    id: 'M30', file: 'database/repositories/bets.core.js', config: PG,
    test: 'database/tests/betSettlementPg.test.js',
    why: 'resolveBetId stops looking at public_id, so a placed bet is unreachable',
    from: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 OR public_id = $1 LIMIT 1\`,`,
    to: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 LIMIT 1\`,`,
  },
  // ── Money-domain READS follow authority (docs/MONEY_READS_MIGRATION.md) ───
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
  // M46 (setKycStatus outside its transaction) deleted 2026-10-02 with KYC.
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
  // M49 and M50 (the Aadhaar export lock; deleting only FAILED Aadhaar rows)
  // deleted 2026-10-02 with KYC: the queue they guarded no longer exists.

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
    // one withdrawal, one order (2d) — so the mutation is to put a
    // record-field gate back in FRONT of it.
    from: `  const orderId = \`WD_\${crypto.randomBytes(12).toString('hex')}\`;`,
    to: `  if (user.winningsBalance < tokenAmount) throw Object.assign(new Error('Insufficient winnings'), { status: 400 });
  const orderId = \`WD_\${crypto.randomBytes(12).toString('hex')}\`;`,
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
    // Retargeted 2026-10-07: `creditReserve` is gone — the reserve share is
    // credited by `creditBuyWithin`, inside the pool spend's transaction.
    id: 'M55', file: 'database/repositories/wallets.js', config: PG,
    test: 'database/tests/depositConservationPg.test.js',
    why: 'a deposit reserve is credited to the withdrawable pocket instead',
    from: `    { field: 'reserveBalance', amountPaise: split.reservePaise, txId: \`reserve_credit_\${orderId}\`, reason: \`Deposit reserve allocation \${orderId}\` },`,
    to: `    { field: 'depositBalance', amountPaise: split.reservePaise, txId: \`reserve_credit_\${orderId}\`, reason: \`Deposit reserve allocation \${orderId}\` },`,
  },
  // ── The controls that were defined nowhere ───────────────────────────────
  // M57/M58 guarded the IP deny-list, removed 2026-09-30 (it never ran).
  {
    // Retargeted 2026-10-07: `allowNegative` is gone (no writer may take a
    // pocket below zero, `wallets_pockets_nonneg`), so adding it changed
    // nothing and the entry SURVIVED forever. The guard that answers an
    // over-debit is the WHERE in `moveBalances`; without it the CHECK still
    // holds, but the admin gets a constraint error instead of INSUFFICIENT.
    id: 'M59', file: 'database/repositories/wallets.core.js', config: PG,
    test: 'database/tests/securityChatAdjustmentPg.test.js',
    why: 'the over-debit guard leaves the UPDATE, so an admin debit past the balance is a constraint error, not a refusal they can read',
    from: `    if (delta < 0) guards.push(\`AND \${column} + \${placeholder} >= 0\`);`,
    to: ``,
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
    to: `router.get('/users/flagged-unreachable', authenticate, hasPermission('canManageUsers'), async (req, res) => {`,
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
    // Retargeted 2026-10-02 (Step 2c): the rail is derived from the order's own
    // currency and size, not read from a platform-wide policy.
    id: 'M92', file: 'database/repositories/orders.record.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'the order insert stops deriving the rail from the order, so a cash-sized buy is stamped UPI and routed to a team that pays no cash',
    from: `  const paymentMode = paymentModeFor({ currency: detail.currency, tokenAmountPaise: tokenPaise });`,
    to: `  const paymentMode = 'P2P_UPI';`,
  },
  {
    id: 'M94', file: 'database/schema.sql', config: PG,
    test: 'database/tests/paymentModeImmutabilityPg.test.js',
    why: 'the database stops refusing a rail change, so a future SETTABLE edit could move an in-flight order',
    from: `  IF NEW.payment_mode IS DISTINCT FROM OLD.payment_mode THEN`,
    to: `  IF FALSE THEN`,
  },

  // ── One merchant, one denomination ──────────────────────────────────────
  // On the cash rail a merchant stands at an ATM that dispenses one amount.
  // Offering them another is offering an order they physically cannot serve.

  // ── The ATM cash-link queue ─────────────────────────────────────────────
  // A link is a claim on physical notes about to leave a machine.

  // ── What a player may buy or sell, enforced on the server ───────────────
  // The player app ships as an APK containing the whole JS bundle, so every
  // one of these is reachable by a hand-made request. Retargeted 2026-10-03
  // (Step 2d): an order is one of the fixed sizes the admin has on offer.
  {
    id: 'M105', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/orderSizesPg.test.js',
    why: 'a buy for an amount that is not an order size is accepted, so it waits on a rail no team is organised to serve',
    from: `  if (!offered.includes(tokenAmount)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M106', file: 'backend/domains/merchant/denominations.js', config: PG,
    test: 'backend/tests/routes/orderSizesPg.test.js',
    why: 'a size the admin switched off is still accepted, so the admin cannot stop a rail being offered work its teams cannot take',
    from: `  return ORDER_SIZES.filter((size) => list.includes(size));`,
    to: `  return [...ORDER_SIZES];`,
  },
  {
    id: 'M107', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/orderSizesPg.test.js',
    why: 'a player opens unlimited simultaneous buys and can occupy several merchants at once during a shortage',
    from: `  if (open > 0) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M109', file: 'backend/domains/configuration/systemConfigPayload.js', config: UNIT,
    test: 'backend/tests/unit/systemConfigPayload.test.js',
    why: 'the client is told a different set of sizes than the gate enforces, so the picker offers what the server refuses',
    from: `      CASH:     offeredSizesFor(cfg, 'CASH'),`,
    to: `      CASH:     [100, 200, 300],`,
  },
  {
    id: 'M344', file: 'database/repositories/config.js', config: PG,
    test: 'backend/tests/routes/orderSizesPg.test.js',
    why: 'the admin can store a size that is not one of the seven, and the stored list stops saying what is on offer',
    from: `        const bad = nums.filter((v) => !field.allowed.includes(v));`,
    to: `        const bad = [];`,
  },
  {
    id: 'M345', file: 'database/repositories/config.js', config: PG,
    test: 'database/tests/configPairedBoundsPg.test.js',
    why: 'a USDT bound that is not a whole step is stored, so the player is offered a range no step lands on',
    from: `      if (field.multipleOf && num % field.multipleOf !== 0) {`,
    to: `      if (false) {`,
  },
  {
    id: 'M346', file: 'backend/domains/configuration/tokenRates.js', config: UNIT,
    test: 'backend/tests/unit/tokenRates.test.js',
    why: 'the tokens for a USDT buy are computed in floating point, so 100 USDT at ₹64.35 is priced a fraction of a paisa off and refused',
    from: `  const ratePaise = Math.round(rate * 100);`,
    to: `  const ratePaise = rate * 100;`,
  },
  {
    id: 'M347', file: 'database/repositories/orderRails.js', config: PG,
    test: 'backend/tests/routes/orderSizesPg.test.js',
    why: 'the rail boundary moves, so a 50,000 buy is sent to a cash team at a machine that cannot pay it',
    from: `const MAX_CASH_SIZE_PAISE = Math.max(...CASH_SIZES) * 100;`,
    to: `const MAX_CASH_SIZE_PAISE = 50_000 * 100;`,
  },

  // ── Every sell is a bank transfer, with its UTR (2d) ────────────────────
  {
    id: 'M348', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/payoutReferencePg.test.js',
    why: 'a cash-team sell is confirmed with no bank reference, so the payout has nothing a dispute can be matched against and one transfer can be claimed twice',
    from: `        let payoutReference = null;
        if (!isDeposit) {`,
    to: `        let payoutReference = null;
        if (!isDeposit && order.paymentMode !== 'CASH_ATM') {`,
  },
  {
    id: 'M116', file: 'backend/domains/merchant/merchantOrderView.js', config: PG,
    test: 'backend/tests/routes/merchantOrderPrivacyRoutes.test.js',
    why: 'the merchant panel stops being told which rail an order was born on, so a cash buy is worked as a UPI one — the member is never asked for the payment link the player is waiting on',
    from: `  'paymentMode',`,
    to: ``,
  },

  // ── One withdrawal is one order, of one size ────────────────────────────
  {
    // Retargeted 2026-10-03 (2d): every order is one of the fixed sizes, and a
    // withdrawal that is not one is refused before any money moves.
    id: 'M117', file: 'backend/domains/risk/riskValidation.service.js', config: PG,
    test: 'backend/tests/routes/oneWithdrawalPg.test.js',
    why: 'a withdrawal is created for an amount that is not an order size, so no team is organised to pay it and the tokens lock behind an order nobody can serve',
    from: `  if (!offered.includes(tokenAmount)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M121', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/oneWithdrawalPg.test.js',
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
    why: 'the window stops coming from SystemConfig, so the number an admin edits on the settings screen decides nothing again',
    from: `  const graceSeconds = routingSettings(await getSystemConfig()).utrSubmitSeconds;`,
    to: `  const graceSeconds = 60;`,
  },

  // ── Retry, and the link that arrives late ───────────────────────────────
  {
    id: 'M127', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'the queue stops ranking retries first, so a player who already waited and got nothing goes to the back of the queue that failed them',
    from: `      ORDER BY assignment_priority DESC, created_at ASC`,
    to: `      ORDER BY created_at ASC`,
  },
  {
    id: 'M129', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/retryAndMatchPg.test.js',
    why: 'an order that is still live can be retried, so a player gets a second order for money already in flight — two merchants on a buy, and on a sell their tokens locked twice',
    from: `  const retryable = ['CANCELLED', 'FAILED'].includes(original.status);`,
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
    id: 'M136', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/assignmentWindowPg.test.js',
    why: 'an order no member ever took is never expired: creation sets no deadline, so it waits forever and a withdrawal locks a player\'s money with nothing scheduled to release it',
    from: `              OR (o.expires_at IS NULL
                  AND o.state = 'PENDING_QUEUE'`,
    to: `              OR (FALSE AND o.expires_at IS NULL
                  AND o.state = 'PENDING_QUEUE'`,
  },
  {
    id: 'M137', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/assignmentWindowPg.test.js',
    why: 'an order is swept the moment it is created, so a buy a member was about to take is cancelled out from under both of them',
    from: `                  AND o.created_at < now() - make_interval(secs => $2))`,
    to: `                  AND o.created_at < now() - make_interval(secs => LEAST($2, 0)))`,
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
  if (snapshot.merchantRef) view.merchantRef = snapshot.merchantRef;`,
    to: `  return { ...snapshot };
  // eslint-disable-next-line no-unreachable
  const view = {};
  if (snapshot.merchantRef) view.merchantRef = snapshot.merchantRef;`,
  },
  {
    id: 'M140', file: 'backend/domains/payment/payment.routes.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the status poll — the response that fires most often, every few seconds while a player waits — stops projecting and pushes the merchant credentials again',
    from: `      payTo:           view.payTo ?? null,`,
    to: `      payTo:           order.merchantSnapshot,`,
  },
  // ── B7: the USDT merchant rail, and one payment claimed once ─────────────
  {
    // Retargeted 2026-10-02 (Step 2c): routing is to team members now.
    id: 'M143', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'the chain filter goes, so a USDT order is offered to a member with no address on that network: the player sends to a chain the address does not exist on and the tokens are gone',
    from: "        ${chainColumn ? `AND m.${chainColumn} IS NOT NULL AND m.${chainColumn} <> ''` : ''}",
    to: "        ${''}",
  },
  {
    id: 'M144', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'an unknown chain matches nobody SILENTLY instead of throwing, which reads on a screen as "nobody is free" and has a player wait through a malformed request',
    from: "    if (!chainColumn) throw new TypeError(`routingCandidates: unknown usdtChain '${order.usdtChain}'`);",
    to: "    if (!chainColumn) chainColumn = 'usdt_address_trc20';",
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
    why: 'any USDT amount is accepted, so the admin bounds and the 100-USDT step stop holding and a member is asked for a sum the screen never offered',
    from: `    if (!isUsdtBuyAmount(usdtAmount, bounds)) {`,
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
    from: `  if (accepted && isBuy && snapshot.usdtPayTo && snapshot.usdtChain) {
    view.usdtAddress = snapshot.usdtPayTo;`,
    to: `  if (accepted && isBuy && (snapshot.usdtAddressTrc20 || snapshot.usdtAddressBep20)) {
    view.usdtAddress = snapshot.usdtAddressTrc20 || snapshot.usdtAddressBep20;
    view.usdtAddressBep20 = snapshot.usdtAddressBep20;`,
  },
  {
    id: 'M151', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/merchantPanelRoutes.test.js',
    why: 'a merchant may accept a USDT order on a chain they hold no address for, so the player is shown nothing to send to, or the other chain\'s address',
    from: `            if (!usdtAddressFor(merchant, order.usdtChain)) {`,
    to: `            if (false) {`,
  },
  {
    id: 'M152', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'a USDT purchase with no rate set is priced at the INR peg instead of refused, so 50,000 tokens are sold for 50,000 USDT and a player might take it',
    from: `    if (quoted === null) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M153', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/usdtMerchantRailPg.test.js',
    why: 'the tokens stop coming from the rate, so a player who sends 100 USDT is credited 100 tokens — the USDT and the tokens become the same number',
    from: `    tokenAmount = quoted.tokens;`,
    to: `    tokenAmount = usdtAmount;`,
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
    from: `    paymentMode, usdtChain, deriveOrderHmac(orderId)];`,
    to: `    paymentMode, usdtChain, null];`,
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
    // Retargeted 2026-10-02 (Step 2c): the hold lives in the team's pool.
    id: 'M167', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/depositConservationPg.test.js',
    why: "a confirmed buy is charged to the pool's available tokens even though its hold already paid for it, so the team pays twice and a fully committed team can never confirm",
    from: `      if (held > 0) {
        await client.query('UPDATE order_states SET pool_held_paise = 0 WHERE order_id = $1', [oid]);`,
    to: `      if (false) {
        await client.query('UPDATE order_states SET pool_held_paise = 0 WHERE order_id = $1', [oid]);`,
  },

  // ── An admin ends a withdrawal through ONE owner ────────────────────────
  // Ten of eleven route × money-position cells were wrong: refunds credited
  // winnings and left the lock, releases moved nothing, a HELD settlement was
  // stranded, and a refunded dispute was written back to DISPUTED.
  {
    // Retargeted 2026-10-07: the never-settled refund returns the stake
    // through `refundWithdrawal` (locked -> winnings, one key).
    id: 'M169', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'an admin refund never takes the stake out of the lock, so the player holds the amount twice and the token total no longer adds up',
    from: `  if (order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }`,
    to: `  if (false) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }`,
  },
  {
    // Retargeted 2026-10-07: the release settles the sell — the pool credit and
    // the stake leaving `locked` are one transaction (`creditSellToPool`), so
    // there is no second call left to forget.
    id: 'M170', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'an admin release mirrors the order as settled while the stake stays locked and the team is never paid',
    from: `    const settled = await settleSell(order.orderId, { actor });
    if (!settled.ok) return { ok: false, reason: settled.reason };`,
    to: `    const settled = { ok: true };`,
  },
  {
    id: 'M171', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'the settlement mirror writes the order state behind the route, so a refunded dispute is written back to DISPUTED and returns to the queue',
    // Two layered guards since review C3 (2026-09-30): `keepState` for the
    // admin routes, and the UPDATE writing state only from PAID. Either alone
    // keeps a route-moved order where the route put it, so removing ONE is
    // unkillable by construction — CI reported this entry SURVIVED once C3
    // landed. The property is lost only when both go; M178 covers the PAID
    // guard on its own, through the race it exists for.
    edits: [
      [`  if (keepState) OUTCOME.state = null;`, `  if (false) OUTCOME.state = null;`],
      [`state = CASE WHEN $4::text IS NOT NULL AND state = 'PAID' THEN $4 ELSE state END,`,
       `state = COALESCE($4, state),`],
    ],
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
    why: 'the worker settles on a snapshot of the order: a dispute raised after the read is settled underneath, stake consumed and the team credited',
    from: `    actor: 'settlement-worker', requireState: 'PAID',`,
    to: `    actor: 'settlement-worker',`,
  },
  {
    id: 'M178', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeSettleRacePg.test.js',
    why: 'the settlement mirror writes COMPLETED over a dispute raised after the settlement committed, taking it out of the queue with nobody told',
    from: `state = CASE WHEN $4::text IS NOT NULL AND state = 'PAID' THEN $4 ELSE state END,`,
    to: `state = COALESCE($4, state),`,
  },
  // ── The cash matcher follows the ORDER's rail (review C2, 2026-09-30) ────
  // ── An order is stamped with the rail it was validated for (review C1) ───
  // ── Android release uploads (review C4: P197-2, P197-3) ─────────────────
  {
    id: 'M181', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'the manifest is inflated without a bound, so a zip bomb on one entry inflates gigabytes inside the API process',
    from: `return inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });`,
    to: `return inflateRawSync(raw);`,
  },
  {
    id: 'M182', file: 'backend/domains/distribution/androidRelease.admin.routes.js', config: PG,
    test: 'backend/tests/routes/androidReleaseRoutes.test.js',
    why: 'the upload that loses the race for a version code answers 500 and leaves its stored APK behind',
    from: `        if (err?.code !== '23505') throw err;`,
    to: `        throw err;`,
  },
  // ── The IP deny-list (F-030, rebuilt) ───────────────────────────────────
  {
    id: 'M183', file: 'backend/middleware/ipBlocklist.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'the enforcer serves every address, so a block an admin was told is in force refuses nobody',
    from: `  if (!listCovers(list, req.ip)) return next();`,
    to: `  return next();`,
  },
  {
    id: 'M184', file: 'backend/routes/admin/ipBlocks.admin.routes.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'an admin can block a range covering their own address; behind a misconfigured proxy that is the balancer, and everybody, the admin included, is locked out',
    from: `  if (listCovers(probe, requesterIp)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M185', file: 'backend/routes/admin/ipBlocks.admin.routes.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'a /8 is accepted; behind carrier NAT that blocks a region of players',
    from: `  if (bits < MIN_PREFIX[family]) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M186', file: 'database/repositories/ipBlocks.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'a temporary block never lapses, because the enforcer loads expired rows as live',
    from: 'WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,',
    to: 'WHERE released_at IS NULL`,',
  },
  {
    id: 'M187', file: 'backend/middleware/ipBlocklist.js', config: UNIT,
    test: 'backend/tests/unit/ipBlocklistRefresh.test.js',
    why: 'a failed reload drops to an empty list, so a database blip unblocks every blocked client at once',
    from: `    refreshIpBlocklistNow().catch((error) => {`,
    to: `    refreshIpBlocklistNow().catch((error) => { list = new net.BlockList(); count = 0;`,
  },  // ── Bet placement (R6) ──────────────────────────────────────────────────
  {
    id: 'M188', file: 'backend/domains/markets/bet.routes.js', config: PG,
    test: 'backend/tests/routes/betPlaceRoutesPg.test.js',
    why: 'the stake limits come from the type the client SENDS, so a full-day bet goes under the full-day floor by claiming to be a 30-minute bet',
    from: `const limitsKey = isCycleType(cycle.type) ? limitsKeyFor(cycle.type) : 'thirtyMin';`,
    to: `const limitsKey = isCycleType(req.body.type) ? limitsKeyFor(req.body.type) : 'thirtyMin';`,
  },
  {
    id: 'M189', file: 'database/repositories/bets.js', config: PG,
    test: 'backend/tests/routes/betPlaceRoutesPg.test.js',
    why: 'a bet whose cycle closed during placement is reported refunded while its stake stays locked',
    from: `  return refundBet({
    betId, userId: String(userId), reason,`,
    to: `  return { ok: true }; ({
    betId, userId: String(userId), reason,`,
  },
  {
    id: 'M190', file: 'backend/domains/markets/bet.routes.js', config: PG,
    test: 'backend/tests/routes/betPlaceRoutesPg.test.js',
    why: 'a failed refund is swallowed and the player is told "fully restored" while the stake is still locked',
    from: `      } catch (refundErr) {`,
    to: `      } catch (refundErr) { return res.status(400).json({ success: false, message: 'Betting window just closed. Your balance has been fully restored.' });`,
  },
  {
    id: 'M191', file: 'backend/domains/markets/bet.routes.js', config: PG,
    test: 'backend/tests/routes/betPlaceRoutesPg.test.js',
    why: 'a phantom bet with a non-numeric amount reaches rupeesToPaise and answers 500',
    from: `    if (!Number.isFinite(amount) || amount < 1) {`,
    to: `    if (amount < 1) {`,
  },  // ── Cancelled cycles return their stakes (R6) ────────────────────────────
  {
    id: 'M192', file: 'backend/routes/admin/cycles.admin.routes.js', config: PG,
    test: 'backend/tests/routes/cycleCancelRefundPg.test.js',
    why: 'CANCEL moves the status and returns no stake, so every bet on the cycle stays locked',
    from: 'const voiding = await voidCancelledCycle(cycleId, { actor: `admin:${req.user.userId}` })',
    to: 'const voiding = await Promise.resolve({ ok: true, voided: 2, refused: [] })',
  },
  {
    id: 'M193', file: 'database/repositories/settlements.js', config: PG,
    test: 'backend/tests/routes/cycleCancelRefundPg.test.js',
    why: 'a cycle still being played has its stakes handed back',
    from: `  if (rows[0].status !== 'CANCELLED') return { ok: false, reason: 'not_cancelled', status: rows[0].status };`,
    to: `  if (false) return { ok: false, reason: 'not_cancelled', status: rows[0].status };`,
  },
  {
    id: 'M194', file: 'database/repositories/settlements.js', config: PG,
    test: 'backend/tests/routes/cycleCancelRefundPg.test.js',
    why: 'the recovery sweep never finds a cancelled cycle whose stakes were left locked',
    from: `      WHERE c.status = 'CANCELLED'
        AND EXISTS`,
    to: `      WHERE c.status = 'CLOSED'
        AND EXISTS`,
  },  // ── Second-factor guesses are counted per ACCOUNT (R6) ──────────────────
  {
    id: 'M195', file: 'backend/middleware/security.js', config: UNIT,
    test: 'backend/tests/unit/rateLimitKeys.test.js',
    why: 'the 2FA budget is per challenge token, so each correct password buys five fresh guesses and the lockout never trips',
    from: `    if (subject) return subject.audience === CHALLENGE_AUDIENCE.MERCHANT ? \`m:\${subject.id}\` : \`u:\${subject.id}\`;`,
    to: `    if (false) return null;`,
  },  // ── A merchant's password has one owner, and a reset evicts its sessions (R6)
  {
    id: 'M196', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/merchantPasswordResetPg.test.js',
    why: 'the merchant door reads a password the reset never writes, so a reset merchant is refused their new password',
    from: `LEFT JOIN users u ON u.user_id = m.user_id AND u.account_type = 'MERCHANT'`,
    to: `LEFT JOIN users u ON FALSE`,
  },
  {
    id: 'M197', file: 'backend/middleware/merchantAuth.js', config: PG,
    test: 'backend/tests/routes/merchantPasswordResetPg.test.js',
    why: 'a password reset evicts no merchant session, so the session the reset was meant to end keeps working',
    from: `    if (sessionSuperseded(login, decoded)) return refuseSupersededSession(res);`,
    to: `    if (false) return refuseSupersededSession(res);`,
  },  // ── A session is checked the same way on every path that accepts one (R6)
  {
    id: 'M198', file: 'backend/startup/socketHandlers.js', config: PG,
    test: 'backend/tests/routes/sessionCutoffEverywherePg.test.js',
    why: 'a signed-out or password-reset session still joins its player room and receives balance pushes',
    from: `        if (!user || !(await sessionIsLive(token, decoded, user))) return;`,
    to: `        if (!user) return;`,
  },
  {
    id: 'M199', file: 'backend/domains/identity/auth.middleware.js', config: PG,
    test: 'backend/tests/routes/sessionCutoffEverywherePg.test.js',
    why: 'the shared session check ignores the reset cutoff, so every inline path honours a superseded session',
    from: `  return !sessionSuperseded(login, decoded);`,
    to: `  return true;`,
  },
  {
    id: 'M200', file: 'backend/routes/sse.routes.js', config: PG,
    test: 'backend/tests/routes/merchantPasswordResetPg.test.js',
    why: 'a merchant whose password was reset keeps the live order feed',
    from: `            if (sessionSuperseded(await merchantLoginRow(merchant), decoded)) {`,
    to: `            if (false) {`,
  },  // ── A contact proves a number only when it is the sender's own (R6) ──────
  {
    id: 'M201', file: 'backend/domains/telegram/telegram.routes.js', config: PG,
    test: 'backend/tests/routes/telegramContactOwnershipPg.test.js',
    why: 'an address-book card with no user_id links the sender to the account holding that number, and the reset button then hands it over',
    from: `  if (!contactUserId || String(contactUserId) !== String(telegramUserId)) {`,
    to: `  if (contactUserId && String(contactUserId) !== String(telegramUserId)) {`,
  },
  // M202 (Aadhaar recovery took a contact card with no user_id) deleted
  // 2026-10-02 with the recovery service. M201 still guards the same check on
  // the one contact-share path that remains.  // ── A referral disbursal reserves its budget before it pays (R6) ────────
  {
    id: 'M203', file: 'backend/domains/referral/referral.service.js', config: UNIT,
    test: 'backend/tests/unit/referralDisbursalBudget.test.js',
    why: 'a disbursal whose budget reservation was refused pays anyway, so the programme ceiling is crossed',
    from: `  if (!reservation.ok) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M204', file: 'database/repositories/referrals.js', config: PG,
    test: 'database/tests/newDomains.test.js',
    why: 'returning unspent budget can drive the drawn total below zero, inventing budget',
    from: `WHERE programme_key = $1 AND disbursed_paise - $2 >= 0`,
    to: `WHERE programme_key = $1`,
  },  // ── Commission recorded is commission delivered; one pass at a time (R6) ─
  // ── Queue writes are gated on a permission, not a tier (R6) ──────────────
  {
    id: 'M207', file: 'backend/routes/admin/_adminShared.js', config: PG,
    test: 'backend/tests/routes/queueWritePermissionPg.test.js',
    why: 'any sub-admin, whatever they hold, can reassign a player\'s order to any merchant or edit the merchant pool',
    from: `    return byPermission(req, res, next);`,
    to: `    return next();`,
  },
  {
    id: 'M208', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinNeedsBetPg.test.js',
    why: 'a provider WIN pays a player on a round they never bet on, or whose bet was rolled back',
    from: `      if (!ctx.round || ctx.round.debitedPaise <= ctx.round.refundedPaise) {`,
    to: `      if (false) {`,
  },
  {
    // Retargeted 2026-10-01: a round is keyed (provider, player, round id), so
    // "whose round is this" is the lock's key, not a check after it. The
    // mutant drops the player from the key, so another player's stake on the
    // same table is found and paid against.
    id: 'M209', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinNeedsBetPg.test.js',
    why: 'a WIN or ROLLBACK naming another player on a shared round is paid against the stake somebody else placed',
    from: `WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 FOR UPDATE`,
    to: `WHERE provider_key = $1 AND $2::text IS NOT NULL AND round_id = $3 FOR UPDATE`,
  },
  {
    id: 'M210', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinNeedsBetPg.test.js',
    why: 'a WIN from one provider pays on a stake placed at a different provider that numbers its rounds the same way',
    from: `WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 FOR UPDATE`,
    to: `WHERE $1::text IS NOT NULL AND user_id = $2 AND round_id = $3 FOR UPDATE`,
  },
  {
    id: 'M211', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'an APK changed after it was signed is accepted for upload and publishing',
    from: `      if (!digestCache.get(algorithm).equals(signedDigest)) {`,
    to: `      if (false) {`,
  },
  {
    id: 'M212', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'a signing block whose signature does not verify is accepted',
    from: `      if (!signatureVerifies(sig.id, publicKey, data, sig.value)) {`,
    to: `      if (false) {`,
  },
  {
    id: 'M213', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'an APK signed by one key is reported under another key\'s certificate',
    from: `    if (!certKey.equals(publicKey)) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M214', file: 'database/repositories/androidReleases.js', config: PG,
    test: 'backend/tests/routes/androidReleaseControlRoutes.test.js',
    why: 'a HALTED release goes on being offered, downloaded and required',
    from: `        WHERE package_name = $1 AND published_at IS NOT NULL AND halted_at IS NULL`,
    to: `        WHERE package_name = $1 AND published_at IS NOT NULL`,
  },
  {
    id: 'M215', file: 'database/repositories/androidReleases.js', config: PG,
    test: 'backend/tests/routes/androidReleaseControlRoutes.test.js',
    why: 'a phone is offered a release its Android cannot install',
    from: `SELECT * FROM live WHERE $2::int IS NULL OR min_sdk IS NULL OR min_sdk <= $2::int`,
    to: `SELECT * FROM live WHERE true OR $2::int IS NULL`,
  },
  {
    id: 'M216', file: 'backend/domains/distribution/androidRelease.shared.js', config: PG,
    test: 'backend/tests/routes/androidReleaseControlRoutes.test.js',
    why: 'a phone too old for a mandatory release keeps running the unsupported build, told nothing',
    from: `  if (policy.unsupportedBelow && installedCode < policy.unsupportedBelow) return 'unsupported';`,
    to: ``,
  },
  {
    id: 'M217', file: 'backend/domains/distribution/androidRelease.admin.routes.js', config: PG,
    test: 'backend/tests/routes/androidReleaseControlRoutes.test.js',
    why: 'a build below a halted release that phones may run is accepted as a draft',
    from: `      const latest = await db.androidReleases.getHighestPublished(expectedPackage());`,
    to: `      const { latest } = await db.androidReleases.getUpdatePolicy(expectedPackage());`,
  },
  {
    id: 'M218', file: 'database/repositories/androidReleases.js', config: PG,
    test: 'backend/tests/routes/androidReleaseControlRoutes.test.js',
    why: 'halting a DRAFT is not refused by name',
    from: `      WHERE release_id = $1 AND published_at IS NOT NULL AND halted_at IS NULL`,
    to: `      WHERE release_id = $1 AND halted_at IS NULL`,
  },
  {
    // 2026-10-01 review of PR #198: the socket.io upgrade never consulted the
    // IP deny-list — measured, a blocked range got 403 on HTTP and a working
    // socket with every broadcast.
    id: 'M219', file: 'backend/middleware/ipBlocklist.js', config: UNIT,
    test: 'backend/tests/unit/ipBlocklistRealtime.test.js',
    why: 'an address refused on every HTTP route still opens a socket and receives every broadcast',
    from: `    return callback(null, !listCovers(list, asExpressSees.ip));`,
    to: `    return callback(null, true);`,
  },
  {
    id: 'M220', file: 'backend/middleware/ipBlocklist.js', config: UNIT,
    test: 'backend/tests/unit/ipBlocklistRealtime.test.js',
    why: 'behind the balancer the socket is judged on the BALANCER\'s address, so no client is ever refused',
    from: `    return callback(null, !listCovers(list, asExpressSees.ip));`,
    to: `    return callback(null, !listCovers(list, raw.socket.remoteAddress));`,
  },
  {
    id: 'M221', file: 'backend/routes/admin/ipBlocks.admin.routes.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'an IPv4 /8 respelled as ::ffff:10.0.0.0/104 clears the /16 floor and blocks a region',
    from: `    if (v4Bits !== null && v4Bits < MIN_PREFIX.ipv4) {`,
    to: `    if (false) {`,
  },
  // ── Staff permissions: every route an area (owner, 2026-10-01) ────────────
  {
    id: 'M222', file: 'backend/domains/identity/staffPermissions.js', config: PG,
    test: 'backend/tests/routes/staffPermissionsPg.test.js',
    why: 'a sub-admin passes every gate whatever they were given: the areas mean nothing',
    from: `  return user.subAdminPermissions?.[key] === true;`,
    to: `  return true;`,
  },
  {
    id: 'M223', file: 'backend/domains/identity/staffPermissions.js', config: PG,
    test: 'backend/tests/routes/adminSubadminsRoutes.test.js',
    why: 'the string "false" is coerced and stored as granted, turning a revoked area back on',
    from: `    if (notBoolean.length) throw refuse(`,
    to: `    if (false) throw refuse(`,
  },
  {
    id: 'M224', file: 'backend/routes/admin/subadmins.admin.routes.js', config: PG,
    test: 'backend/tests/routes/staffPermissionsPg.test.js',
    why: 'a save with no `permissions` key is read as "revoke everything" — what the panel sent on every save',
    from: `    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'permissions')) {`,
    to: `    if (false) {`,
  },
  {
    // Repointed 2026-10-01: the guard's admin branch is gone, and what keeps a
    // staff session off the player's order is now the player door itself.
    id: 'M225', file: 'backend/domains/identity/auth.middleware.js', config: PG,
    test: 'backend/tests/routes/orderAccessGuardRoutes.test.js',
    why: 'any staff account acts as the player on the player\'s order: reads it, and raises a dispute recorded as the player\'s',
    from: `const authenticatePlayer = makeAuthenticate({ accountTypes: ['PLAYER'] });`,
    to: `const authenticatePlayer = makeAuthenticate();`,
  },
  {
    id: 'M226', file: 'backend/domains/notification/sseManager.service.js', config: UNIT,
    test: 'backend/tests/unit/staffRealtimePermissions.test.js',
    why: 'the admin stream sends every order, dispute and KYC event to every staff account, whatever its areas',
    from: `            if (!staffMayReceive(viewer, event)) continue;`,
    to: `            if (false) continue;`,
  },
  {
    id: 'M227', file: 'backend/domains/notification/sseManager.service.js', config: UNIT,
    test: 'backend/tests/unit/staffRealtimePermissions.test.js',
    why: 'a sub-admin whose permissions were changed keeps receiving under the old grant',
    from: `            if (String(viewer.userId) !== String(userId)) continue;`,
    to: `            continue;`,
  },
  {
    id: 'M228', file: 'backend/domains/notification/staffEventAreas.js', config: UNIT,
    test: 'backend/tests/unit/staffRealtimePermissions.test.js',
    why: 'a staff socket joins every area\'s room, so the socket admin room is open to every sub-admin',
    from: `  else rooms.push(...keys.filter((k) => staffCan(viewer, k)).map(staffRoom));`,
    to: `  else rooms.push(...keys.map(staffRoom));`,
  },
  {
    id: 'M229', file: 'backend/routes/sse.routes.js', config: PG,
    test: 'backend/tests/routes/adminStreamPermissionsPg.test.js',
    why: 'the payment queue (every pending order and its player) goes to a sub-admin who only edits content',
    from: `        if (!staffMayReceive(adminUser, 'queue_snapshot')) return;`,
    to: `        if (false) return;`,
  },
  {
    id: 'M230', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/staffPermissionsPg.test.js',
    why: 'an area is quietly made full-admin-only: a sub-admin holding it is refused, and the list says nothing',
    from: `router.get('/phantom-agents', authenticate, hasPermission('canManagePhantomAgents'),`,
    to: `router.get('/phantom-agents', authenticate, isAdmin,`,
  },
  // ── Point 3 of the PR #198 verification (2026-10-01) ─────────────────────
  {
    id: 'M232', file: 'database/repositories/ipBlocks.js', config: PG,
    test: 'backend/tests/routes/ipBlocklistRoutesPg.test.js',
    why: 'the expiry is dated by the APP clock again, so a server running behind the database refuses short blocks',
    from: `CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END)`,
    to: `CASE WHEN $5::int IS NULL THEN NULL ELSE to_timestamp(\${Date.now() / 1000} + $5::int * 60) END)`,
  },
  // ── §37 neighbour pass over R7 (2026-10-01) ───────────────────────────────
  {
    id: 'M234', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'an APK whose v2 and v3 are signed by different keys is recorded under one; Android 7-8 phones see the other',
    from: `  if (verified.some((v) => !v.cert.equals(der))) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M235', file: 'backend/domains/distribution/apkInspector.js', config: UNIT,
    test: 'backend/tests/unit/apkInspector.test.js',
    why: 'a second signer rides in an APK under a key no publish check ever looked at',
    from: `  if (signers.length > 1) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M236', file: 'database/repositories/stats.js', config: PG,
    test: 'backend/tests/routes/analyticsRoutesPg.test.js',
    why: "the dashboard's bet count counts the house's phantom bets as player bets",
    from: `     FROM bets
    WHERE NOT is_phantom\`, [], 'stats_betting',`,
    to: `     FROM bets\`, [], 'stats_betting',`,
  },
  {
    id: 'M237', file: 'backend/routes.js', config: PG,
    test: 'backend/tests/routes/loginSecondFactorPg.test.js',
    why: "a player's 2FA challenge is redeemed at the STAFF door and mints a staff-door session",
    from: `    if (user.accountType !== door.accountType || !door.admits(user))`,
    to: `    if (false)`,
  },
  {
    id: 'M238', file: 'backend/routes.js', config: PG,
    test: 'backend/tests/routes/loginSecondFactorPg.test.js',
    why: 'any six digits complete a staff or player login',
    from: `    if (!verdict.ok) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M239', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/loginSecondFactorPg.test.js',
    why: 'any six digits complete a merchant login',
    from: `        if (!verdict.ok) {`,
    to: `        if (false) {`,
  },
  {
    id: 'M240', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/merchantTwoFactorEnrolmentPg.test.js',
    why: 'any six digits turn a merchant\'s pending secret into their live second factor',
    from: `        if (!verdict.valid)
            return res.status(400).json({ success: false, message: 'That code did not match.`,
    to: `        if (false)
            return res.status(400).json({ success: false, message: 'That code did not match.`,
  },
  {
    id: 'M241', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/merchantTwoFactorEnrolmentPg.test.js',
    why: 'a session holder replaces an enrolled merchant\'s live authenticator by running setup again',
    from: `        if (creds.twoFactorEnabled)
            return res.status(400).json({ success: false,`,
    to: `        if (false)
            return res.status(400).json({ success: false,`,
  },
  {
    id: 'M242', file: 'backend/domains/payment/paymentOrder.routes.js', config: PG,
    test: 'backend/tests/routes/queueWritePermissionPg.test.js',
    why: "a queue manager's one screen cannot load its own queue",
    from: `router.get('/payment-queue', authenticate, queueManagerOrPermission('canManageMerchants'),`,
    to: `router.get('/payment-queue', authenticate, hasPermission('canViewTransactions'),`,
  },
  // ── Staff authority on STAFF rows only; a deleted account is closed (2026-10-01) ──
  {
    id: 'M243', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'a staff flag can be written onto a PLAYER row, and that player\'s own session carries it',
    from: `CHECK (account_type = 'STAFF' OR NOT (is_admin OR is_sub_admin OR is_queue_manager OR is_mediator));`,
    to: `CHECK (TRUE);`,
  },
  {
    id: 'M244', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'the queue-manager grant accepts a PLAYER id and the admin is not told why it failed',
    from: `if (target.accountType !== 'STAFF') {`,
    to: `if (false) {`,
  },
  {
    id: 'M245', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/closedAccountPg.test.js',
    why: 'a sub-admin holding the players area can close the full admin\'s account',
    from: `WHERE user_id = $1 AND status <> 'DELETED' AND account_type = 'PLAYER'`,
    to: `WHERE user_id = $1 AND status <> 'DELETED'`,
  },
  {
    id: 'M246', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/closedAccountPg.test.js',
    why: 'a deleted account keeps every socket and SSE stream it already held',
    from: `sessions_valid_from = now(), updated_at = now()
      WHERE user_id = $1 AND status <> 'DELETED'`,
    to: `updated_at = now()
      WHERE user_id = $1 AND status <> 'DELETED'`,
  },
  {
    id: 'M247', file: 'backend/routes.js', config: PG,
    test: 'backend/tests/routes/closedAccountPg.test.js',
    why: 'a deleted player signs in with their password',
    from: `    if (accountClosed(user)) return refuseClosedAccount(res);

    // The hash comes`,
    to: `
    // The hash comes`,
  },
  {
    id: 'M248', file: 'backend/routes.js', config: PG,
    test: 'backend/tests/routes/closedAccountPg.test.js',
    why: 'an account closed between the two legs of a login completes the second',
    from: `    if (accountClosed(user)) return refuseClosedAccount(res);
    // The SAME door`,
    to: `    // The SAME door`,
  },
  {
    id: 'M249', file: 'backend/domains/identity/auth.middleware.js', config: PG,
    test: 'backend/tests/routes/closedAccountPg.test.js',
    why: 'a deleted account is told its password changed instead of that it is closed',
    from: `    if (accountClosed(user)) return refuseClosedAccount(res);`,
    to: ``,
  },
  // ── Boot order, and the balance-adjust area (2026-10-01) ─────────────────
  {
    id: 'M250', file: 'backend/server.js', config: UNIT,
    test: 'backend/tests/unit/schedulersWaitForSchema.test.js',
    why: 'the settlement engine and cycle generator race the schema apply (deadlock measured)',
    from: `    gameEngine.start();
    cycleGenerator.start();
    registerCronJobs(rebuildLeaderboard);`,
    to: `    registerCronJobs(rebuildLeaderboard);`,
  },
  {
    id: 'M251', file: 'backend/routes/retention.routes.js', config: PG,
    test: 'backend/tests/routes/balanceAdjustAreaPg.test.js',
    why: 'an admin credits money onto a staff or merchant login',
    from: `if (user.accountType !== 'PLAYER') {`,
    to: `if (false) {`,
  },
  {
    id: 'M252', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/balanceAdjustAreaPg.test.js',
    why: "the balance-adjust lookup offers staff and merchant logins as players",
    from: `if (accountType) add('account_type = $?', String(accountType));`,
    to: ``,
  },
  {
    id: 'M253', file: 'backend/middleware/errorHandler.js', config: UNIT,
    test: 'backend/tests/unit/globalErrorHandler.test.js',
    why: 'any uncaught route error hands the caller the server\'s internal text',
    from: `const decided = Boolean(err?.status || err?.statusCode);`,
    to: `const decided = true;`,
  },
  // ── A session is used at its own panel's door (2026-10-01) ──────────────
  {
    id: 'M254', file: 'backend/domains/identity/auth.middleware.js', config: PG,
    test: 'backend/tests/routes/playerDoorPg.test.js',
    why: 'a merchant\'s session reads the player\'s projection of an order assigned to it, and a staff session creates deposits in its own name',
    from: `    if (belongsElsewhere(user, accountTypes)) return refuseWrongPanel(res, user);`,
    to: ``,
  },
  {
    id: 'M255', file: 'backend/domains/identity/auth.middleware.js', config: PG,
    test: 'backend/tests/routes/playerDoorPg.test.js',
    why: 'a staff session passes the player door: deposits, bets and support tickets in a staff account\'s name',
    from: `const authenticatePlayer = makeAuthenticate({ accountTypes: ['PLAYER'] });`,
    to: `const authenticatePlayer = makeAuthenticate({ accountTypes: ['PLAYER', 'STAFF'] });`,
  },
  {
    id: 'M256', file: 'backend/routes.js', config: PG,
    test: 'backend/tests/routes/playerDoorPg.test.js',
    why: 'a merchant\'s session restores itself on /me, the endpoint every player and admin page load reads',
    from: `    if (belongsElsewhere(user, ['PLAYER', 'STAFF'])) return refuseWrongPanel(res, user);`,
    to: ``,
  },
  {
    id: 'M257', file: 'backend/middleware/order-crypto-access.js', config: PG,
    test: 'backend/tests/routes/orderAccessGuardRoutes.test.js',
    why: 'any signed-in player reads, pays and disputes another player\'s order',
    from: `    if (uid === null || String(order.userId) !== uid) return refuse();`,
    to: `    if (uid === null) return refuse();`,
  },
  {
    id: 'M258', file: 'backend/startup/socketHandlers.js', config: PG,
    test: 'backend/tests/routes/playerDoorPg.test.js',
    why: 'a merchant\'s or staff member\'s session joins a player socket room',
    from: `        if (user.accountType === 'PLAYER' && user.userId?.toString() === userId?.toString()) {`,
    to: `        if (user.userId?.toString() === userId?.toString()) {`,
  },
  {
    id: 'M259', file: 'backend/startup/socketHandlers.js', config: PG,
    test: 'backend/tests/routes/playerDoorPg.test.js',
    why: 'a full admin\'s session joins ANY player\'s room: every balance push and order update for that player',
    from: `        if (user.accountType === 'PLAYER' && user.userId?.toString() === userId?.toString()) {`,
    to: `        if ((user.accountType === 'PLAYER' && user.userId?.toString() === userId?.toString()) || user.isAdmin) {`,
  },
  {
    id: 'M260', file: 'backend/routes/admin/users.admin.routes.js', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'phantom access is granted to a staff account that can never use it, and the admin is told it failed for no reason',
    from: `    if (accessLevel !== 'NONE' && user.accountType !== 'PLAYER') {`,
    to: `    if (false) {`,
  },
  {
    id: 'M261', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/adminUsersRoutes.test.js',
    why: 'phantom access can be written onto a staff or merchant row by any path',
    from: `  CHECK (account_type = 'PLAYER' OR phantom_access = 'NONE');`,
    to: `  CHECK (TRUE);`,
  },
  // ── What the server tells a merchant reaches their screen (2026-10-01) ──
  {
    id: 'M262', file: 'backend/domains/disputes/disputeResolution.admin.routes.js', config: PG,
    test: 'backend/tests/routes/disputeResolutionRoutes.test.js',
    why: 'a resolved dispute stays DISPUTED on the merchant\'s screen: the push goes nowhere the panel listens',
    from: `      emitMerchantUpdate(order.merchantId, 'order_update', {`,
    to: `      global.io?.to(\`merchant-\${order.merchantId}\`).emit('order_update', {`,
  },
  {
    id: 'M263', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/utrGracePg.test.js',
    why: 'a moved UTR deadline goes out under a name the merchant panel never registered, so their countdown is wrong',
    from: `    emitMerchantUpdate(String(extended.merchantId), 'order_update', {`,
    to: `    emitMerchantUpdate(String(extended.merchantId), 'order_updated', {`,
  },
  // ── Retention, from the Operations screen (2026-10-01) ──────────────────
  {
    id: 'M264', file: 'backend/domains/operations/operations.admin.routes.js', config: PG,
    test: 'backend/tests/routes/retentionRunRoutesPg.test.js',
    why: 'a retention run that failed is answered success: true, and the screen reports a prune that never ran',
    from: `    if (outcome.results?.error) {`,
    to: `    if (false) {`,
  },
  {
    id: 'M265', file: 'backend/domains/operations/operations.admin.routes.js', config: PG,
    test: 'backend/tests/routes/retentionRunRoutesPg.test.js',
    why: 'a prune deletes rows for good and leaves no record of who ran it',
    from: `    if (!dryRun) {
      await db.audit.recordDetailed({`,
    to: `    if (false) {
      await db.audit.recordDetailed({`,
  },
  {
    id: 'M266', file: 'backend/domains/operations/operations.admin.routes.js', config: PG,
    test: 'backend/tests/routes/retentionRunRoutesPg.test.js',
    why: 'a request that does not say dryRun deletes instead of previewing',
    from: `    const dryRun = req.body?.dryRun !== false; // default to a safe preview`,
    to: `    const dryRun = req.body?.dryRun === true;`,
  },
  // ── A player is not shown the admin's note, or the staff id (2026-10-01) ─
  {
    id: 'M267', file: 'backend/domains/user/user.routes.js', config: PG,
    test: 'backend/tests/routes/playerLedgerViewPg.test.js',
    why: 'the player\'s wallet history shows "[Admin:<staff id>] <internal note>" as the title of every support adjustment',
    from: `    res.json({ success: true, ...result, entries: result.entries.map(toPlayerLedgerEntry) });`,
    to: `    res.json({ success: true, ...result });`,
  },
  {
    id: 'M268', file: 'backend/routes/retention.routes.js', config: PG,
    test: 'backend/tests/routes/playerLedgerViewPg.test.js',
    why: 'the player\'s bonus history carries the admin\'s note for the audit trail',
    from: `    res.json({ success: true, ...result, records: result.records.map(toPlayerBonus) });`,
    to: `    res.json({ success: true, ...result });`,
  },
  {
    id: 'M269', file: 'backend/domains/wallet/playerLedgerView.js', config: PG,
    test: 'backend/tests/routes/playerLedgerViewPg.test.js',
    why: 'an adjustment is not recognised, so its note passes through to the player',
    from: `const isAdjustment = (entry) => String(entry?.txId ?? '').startsWith(ADJUSTMENT_TX_PREFIX);`,
    to: `const isAdjustment = () => false;`,
  },
  // ── The Merchant Platform's per-merchant figures (2026-10-01) ───────────
  {
    id: 'M271', file: 'backend/domains/merchant/merchantAnalytics.service.js', config: PG,
    test: 'backend/tests/routes/merchantPlatformStatsPg.test.js',
    why: 'a USDT merchant\'s volume is labelled as rupees on the admin screen',
    from: `    currency: merchantTypeOf(merchant),`,
    to: `    currency: 'INR',`,
  },
  // ── A create is a create (2026-10-01) ───────────────────────────────────
  {
    id: 'M272', file: 'backend/domains/gameRegistry/gameRegistry.routes.js', config: PG,
    test: 'backend/tests/routes/gameRegistryAdminRoutesPg.test.js',
    why: 'creating a game whose slug exists overwrites it, and two simultaneous creates both answer 200',
    from: `      }, { createOnly: true });
      if (!game) {`,
    to: `      });
      if (!game) {`,
  },
  {
    id: 'M273', file: 'backend/domains/gameRegistry/gameRegistry.routes.js', config: PG,
    test: 'backend/tests/routes/gameRegistryAdminRoutesPg.test.js',
    why: 'creating a category whose slug exists overwrites it and re-enables a disabled one',
    from: `    }, { createOnly: true });
    if (!category) {`,
    to: `    });
    if (!category) {`,
  },
  // ── Curated winners (2026-10-01) ────────────────────────────────────────
  {
    id: 'M274', file: 'backend/routes/winners.routes.js', config: PG,
    test: 'backend/tests/routes/curatedWinnersRoutesPg.test.js',
    why: 'an entry created at a positive amount is edited to a negative one and published',
    from: `      if (!(Number.isFinite(rupees) && rupees > 0)) {`,
    to: `      if (false) {`,
  },
  {
    id: 'M275', file: 'backend/routes/winners.routes.js', config: PG,
    test: 'backend/tests/routes/curatedWinnersRoutesPg.test.js',
    why: 'an edit to a public payout claim leaves no record of who made it',
    from: `      performedBy: req.user.userId, action: 'CURATED_WINNER_UPDATED', category: 'CONTENT',`,
    to: `      performedBy: req.user.userId, action: 'CURATED_WINNER_EDIT_X', category: 'CONTENT',`,
  },
  {
    id: 'M276', file: 'database/repositories/engagement.js', config: PG,
    test: 'backend/tests/routes/curatedWinnersRoutesPg.test.js',
    why: 'the public winners feed publishes the staff id that wrote each curated entry',
    from: `    badge: r.badge ?? '',
    displayTime: r.display_time,
    isReal: false,`,
    to: `    badge: r.badge ?? '',
    displayTime: r.display_time,
    createdBy: r.created_by,
    isReal: false,`,
  },
  // ── KYC removed (owner, 2026-10-02): the signup writer ─────────────────────
  {
    id: 'M277', file: 'database/repositories/identity.js', config: PG,
    test: 'database/tests/identityPg.test.js',
    why: 'the signup form writes its account into the STAFF population, so the player door can never read it back',
    from: `VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'PLAYER')`,
    to: `VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'STAFF')`,
  },
  {
    id: 'M278', file: 'database/repositories/identity.js', config: PG,
    test: 'database/tests/identityPg.test.js',
    why: 'a second player signup on one mobile is reported as created, so the route seats a player on an account that is not theirs',
    from: `    if (!rows[0]) return { ok: false, reason: 'mobile_taken' };`,
    to: `    if (!rows[0]) return { ok: true, userId: String(userId) };`,
  },
  {
    id: 'M279', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'a redelivered channel join hands out a SECOND joining number, moving the player down the referral payout queue and counting them twice',
    from: `        WHERE user_id = $1 AND joining_number IS NULL`,
    to: `        WHERE user_id = $1`,
  },
  {
    id: 'M280', file: 'database/repositories/users.js', config: PG,
    test: 'database/tests/userPg.test.js',
    why: 'the referral member count advances on every repeat of a completion, so the cap fills with people counted twice',
    from: `        WHERE programme_key = 'main' AND EXISTS (SELECT 1 FROM claimed)`,
    to: `        WHERE programme_key = 'main'`,
  },
  // ── Supervisors and teams (Step 2a) ────────────────────────────────────────
  {
    id: 'M281', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamsPg.test.js',
    why: 'a supervisor can create a fifth team, and as many more as they ask for',
    from: `    if (c[0].n >= MAX_TEAMS) return { ok: false, reason: 'team_limit' };`,
    to: `    if (false) return { ok: false, reason: 'team_limit' };`,
  },
  {
    id: 'M282', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamsPg.test.js',
    why: 'proposals arriving together each count the team before the others land, so a team fills past ten',
    from: `'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2 FOR UPDATE',`,
    to: `'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2',`,
  },
  {
    id: 'M283', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamsPg.test.js',
    why: 'every further departure restarts the grace day, so a team can be kept working below ten indefinitely',
    from: `          WHEN t.was_full THEN COALESCE(t.short_since, now())`,
    to: `          WHEN t.was_full THEN now()`,
  },
  {
    id: 'M284', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamsPg.test.js',
    why: 'a supervisor can add members to another supervisor\'s team',
    from: `'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2 FOR UPDATE',`,
    to: `'SELECT team_id FROM teams WHERE team_id = $1 AND $2::text IS NOT NULL FOR UPDATE',`,
  },
  {
    id: 'M285', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamsPg.test.js',
    why: 'the grace day never ends, so a team below ten keeps taking orders for good',
    from: `     AND (t.short_since AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    to: `     AND true`,
  },
  // No M286. "Only a supervisor reaches the supervisor routes" is enforced
  // TWICE on purpose — `requireSupervisor` in team.merchant.routes.js, and
  // createTeam's own `is_supervisor` read under the lock (every other
  // supervisor route is scoped by supervisor_id in its WHERE). A mutant of
  // either alone behaves identically, so it was measured SURVIVED and deleted
  // rather than kept as a permanent false hole (see the note on M101).

  {
    id: 'M287', file: 'backend/domains/team/team.merchant.routes.js', config: PG,
    test: 'backend/tests/routes/teamRoutesPg.test.js',
    why: 'a member of one of the supervisor\'s teams can be removed through another team\'s URL',
    from: `    if (!membership || membership.team.teamId !== req.params.teamId) return refuse(res, 'not_found');`,
    to: `    if (!membership) return refuse(res, 'not_found');`,
  },
  {
    id: 'M288', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamPoolsPg.test.js',
    why: 'a buyback larger than the pool is attempted anyway, and the platform pays for tokens the team does not hold',
    from: `      WHERE team_id = $1 AND available_paise + $2 >= 0`,
    to: `      WHERE team_id = $1`,
  },
  {
    id: 'M289', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamPoolsPg.test.js',
    why: 'a sale into a team pool is booked to the merchant float, so the books say merchants hold tokens a team holds',
    from: `{ [ACCOUNTS.TOKEN_SUPPLY]: -amount, [ACCOUNTS.TEAM_FLOAT]: amount }`,
    to: `{ [ACCOUNTS.TOKEN_SUPPLY]: -amount, [ACCOUNTS.MERCHANT_FLOAT]: amount }`,
  },
  {
    id: 'M290', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamPoolsPg.test.js',
    why: "a supervisor can ask for tokens into another supervisor's team",
    from: `'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2',`,
    to: `'SELECT team_id FROM teams WHERE team_id = $1 OR supervisor_id = $2',`,
  },
  {
    id: 'M291', file: 'database/repositories/teams.js', config: PG,
    test: 'database/tests/teamPoolsPg.test.js',
    why: 'a team that has traded tokens can be deleted, taking the record of where its pool went with it',
    from: `        AND NOT EXISTS (SELECT 1 FROM team_pool_entries WHERE team_id = t.team_id)
        AND NOT EXISTS (SELECT 1 FROM team_pool_requests WHERE team_id = t.team_id)`,
    to: `        AND true`,
  },
  {
    id: 'M292', file: 'backend/domains/team/team.admin.routes.js', config: PG,
    test: 'backend/tests/routes/teamPoolRoutesPg.test.js',
    why: 'any staff member with the Teams area can sell the platform\'s tokens into a pool — the money area is not asked for',
    from: `const POOL_AREA = 'canFundMerchants';`,
    to: `const POOL_AREA = 'canManageTeams';`,
  },
  {
    id: 'M293', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamPoolsPg.test.js',
    why: 'a sale is recorded as money the platform PAID, so every pool sale reads as an outflow in the books',
    from: `  const direction = preview.direction === POOL_DIRECTIONS.BUY ? DIRECTIONS.RECEIVED : DIRECTIONS.PAID;`,
    to: `  const direction = DIRECTIONS.PAID;`,
  },  {
    id: 'M294', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "the open orders are not counted again under the member's lock, so two racing orders both take a member's last place",
    from: "          if (c[0].total >= cap) throw new PoolRefused('member_busy');",
    to: "          if (false) throw new PoolRefused('member_busy');",
  },
  {
    id: 'M295', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "routing ignores team strength, so a team that never reached ten members is given orders",
    from: "        AND (${STRENGTH_SQL}) IN ('WORKING', 'GRACE')\n",
    to: "\n",
  },
  {
    id: 'M296', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a CASH buy is offered to a member who has not said they are at the machine",
    from: "        AND (NOT ($3 AND $1 = 'CASH') OR m.cash_ready)\n",
    to: "\n",
  },
  {
    id: 'M297', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a CASH member holding an open buy is offered a sell too",
    from: "        AND (NOT (NOT $3 AND $1 = 'CASH') OR COALESCE(o.buys, 0) = 0)\n",
    to: "\n",
  },
  {
    id: 'M298', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "ties go to whoever was assigned MOST recently, so one member takes every order while the rest wait",
    from: "m.last_assigned_at ASC NULLS FIRST",
    to: "m.last_assigned_at DESC NULLS LAST",
  },
  {
    id: 'M299', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a sell is assigned without naming its team, so the settled tokens have no pool to land in",
    from: "            await client.query('UPDATE order_states SET team_id = $2 WHERE order_id = $1',\n              [String(order.orderId), cand.teamId]);",
    to: "            void cand.teamId;",
  },
  {
    id: 'M300', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "the pool hold is taken without checking the pool covers it, so racing buys overdraw the team",
    from: "      WHERE team_id = $1 AND available_paise >= $2\n      RETURNING available_paise, held_paise`, [teamId, amount]);\n  if (!pool[0]) throw new Refused('pool_short');",
    to: "      WHERE team_id = $1\n      RETURNING available_paise, held_paise`, [teamId, amount]);\n  if (!pool[0]) throw new Refused('pool_short');",
  },
  {
    id: 'M301', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a confirmed buy can be paid twice: the second confirm takes the tokens again",
    from: "      if (done[0]) return { ok: true, alreadyTaken: true };",
    to: "      void done;",
  },
  {
    id: 'M302', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a release of an order holding nothing still writes an entry and reports a team, so the sweep cannot tell a real release from a no-op",
    from: "WHERE order_id = $1 AND pool_held_paise > 0 FOR UPDATE) prev",
    to: "WHERE order_id = $1 FOR UPDATE) prev",
  },
  {
    id: 'M303', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "a refund takes a sell's tokens back out of a pool that has already used them",
    from: "          WHERE team_id = $1 AND available_paise >= $2 RETURNING available_paise, held_paise`, [teamId, amount]);\n      if (!pool[0] && coverShortfall) {",
    to: "          WHERE team_id = $1 RETURNING available_paise, held_paise`, [teamId, amount]);\n      if (!pool[0] && coverShortfall) {",
  },
  {
    id: 'M304', file: 'database/repositories/orders.core.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: "the transition's `within` step never runs, so an order is assigned with no pool hold behind it",
    from: "    if (within) movedOrder = (await within(client, movedOrder)) ?? movedOrder;",
    to: "    void within;",
  },
  {
    id: 'M305', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a refund retried after the pool refills takes the tokens from the pool as well as from the platform, so the user side is paid twice',
    from: "      if (covered[0]) return { ok: true, covered: true, alreadyCovered: true };",
    to: "      if (false) return { ok: true, covered: true, alreadyCovered: true };",
  },
  {
    id: 'M306', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a refund of a sell the team already used is not covered by the platform, so the player is credited tokens no account moved and USER_FLOAT stops describing the wallets',
    from: "      if (!pool[0] && coverShortfall) {",
    to: "      if (!pool[0] && false) {",
  },

  // ── A withdrawal's stake is consumed OR returned, never both ─────────────
  // A replayed refund of a SETTLED withdrawal branched on the order's mirrored
  // status, which the first refund had rewritten, and paid the player a second
  // time out of another order's locked stake (2c regression, 2026-10-03).
  {
    // Retargeted 2026-10-07: the settled-sell refund returns the stake as
    // WINNINGS (`returnSettledStakeWithin`), inside the pool reversal — it no
    // longer reads `locked` to decide, so what can break is the key.
    id: 'M307', file: 'database/repositories/wallets.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'a refund after settlement takes the stake out of the lock it already left, draining another order\'s locked stake',
    from: `    legs: [{ field: 'winningsBalance', deltaPaise: amountPaise }],
    ledger: [{
      txId: \`dispute_wd_refund_\${orderId}\`, field: 'winningsBalance', amountPaise, type: 'CREDIT',`,
    to: `    legs: [{ field: 'lockedBalance', deltaPaise: 0 - amountPaise }],
    ledger: [{
      txId: \`dispute_wd_refund_\${orderId}\`, field: 'winningsBalance', amountPaise, type: 'CREDIT',`,
  },
  {
    id: 'M308', file: 'database/repositories/wallets.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'a consumed stake can still be returned from the lock, so a replayed refund pays the player twice',
    from: "    excludes: [`wd_release_${withdrawalId}`],",
    to: "    excludes: [],",
  },
  {
    id: 'M309', file: 'database/repositories/wallets.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'a refunded stake can still be consumed, so the team is credited for tokens the player already has back',
    from: `    excludes: [\`refund_\${orderId}\`],`,
    to: `    excludes: [],`,
  },
  {
    id: 'M310', file: 'database/repositories/wallets.core.js', config: PG,
    test: 'backend/tests/routes/withdrawalResolutionPg.test.js',
    why: 'rival movements are never checked, so a stake is both consumed and returned',
    from: "  if (excludes.length) {",
    to: "  if (false) {",
  },

  // ── 2c+: the escrow windows and dispute outcomes ───────────────────────────
  {
    id: 'M311', file: 'database/repositories/orders.core.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'expectFrom is ignored again, so a member\'s reject closes a DISPUTED buy',
    from: "  const allowedFrom = narrowing ? permitted.filter((state) => narrowing.includes(state)) : permitted;",
    to: "  const allowedFrom = permitted;",
  },
  {
    id: 'M312', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the rejected buy is given no window, so the player cannot dispute it',
    from: "`UPDATE order_states SET dispute_window_until = now() + make_interval(mins => $2)",
    to: "`UPDATE order_states SET dispute_window_until = now() - make_interval(mins => $2)",
  },
  {
    id: 'M313', file: 'backend/domains/payment/payment.routes.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the window is not checked, so a player disputes a rejected buy after it closed',
    from: "          if (!await db.orders.rejectedBuyWindowOpenWithin(client, order.orderId)) throw windowClosed;",
    to: "          void client;",
  },
  {
    id: 'M314', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the sweep closes windows that are still open',
    from: "        AND (dispute_window_until IS NULL OR dispute_window_until <= now())",
    to: "        AND TRUE",
  },
  {
    id: 'M315', file: 'backend/domains/payment/rejectedBuyWindow.service.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'a closed window cancels the buy and keeps the team\'s tokens held',
    from: "          await db.teamPools.releaseBuyHoldWithin(client, order.orderId, {",
    to: "          if (false) await db.teamPools.releaseBuyHoldWithin(client, order.orderId, {",
  },
  {
    id: 'M316', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'a rejected buy is retried beside its open window, holding a second team\'s tokens',
    from: "  if (original.status === 'REJECTED') {",
    to: "  if (false) {",
  },
  {
    id: 'M317', file: 'database/spec/config.spec.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the sell hold may be set under the owner\'s one-hour floor',
    from: "  withdrawalHoldMinutes: int(60, 60, 1440),",
    to: "  withdrawalHoldMinutes: int(60, 0, 1440),",
  },
  {
    id: 'M318', file: 'backend/domains/disputes/disputeOutcome.service.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'the loser is the wrong party: a buy decided for the player suspends the player',
    from: "    if (!completed) return FAULT_PARTIES.PLAYER;",
    to: "    if (!completed) return FAULT_PARTIES.MERCHANT;",
  },
  {
    id: 'M319', file: 'backend/domains/disputes/disputeOutcome.service.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a decision on an order that was never disputed suspends somebody',
    from: "  if (!order || order.status !== 'DISPUTED') return { ok: false, reason: 'not_a_dispute' };",
    to: "  if (!order) return { ok: false, reason: 'not_a_dispute' };",
  },
  {
    id: 'M320', file: 'database/repositories/disputeFaults.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a replayed decision counts the loss twice',
    from: "         ON CONFLICT (order_id) DO NOTHING\n         RETURNING order_id`,",
    to: "         ON CONFLICT (order_id) DO UPDATE SET decision = EXCLUDED.decision\n         RETURNING order_id`,",
  },
  {
    id: 'M321', file: 'database/repositories/disputeFaults.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'the third loss does not open high-risk review',
    from: "              high_risk_at  = CASE WHEN lost_disputes + 1 >= $4 THEN COALESCE(high_risk_at, now()) ELSE high_risk_at END,",
    to: "              high_risk_at  = high_risk_at,",
  },
  {
    id: 'M322', file: 'database/repositories/disputeFaults.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a party with no row leaves a record naming nobody',
    from: "      if (!loser[0]) throw new Refused('party_missing');",
    to: "      if (!loser[0]) return { ok: false, reason: 'party_missing' };",
  },
  {
    id: 'M323', file: 'database/repositories/users.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a sub-admin lifts a player in high-risk review',
    from: "        AND ($2 OR $5 OR high_risk_at IS NULL)",
    to: "        AND ($2 OR $5 OR TRUE)",
  },
  {
    id: 'M324', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a sub-admin reinstates a team member in high-risk review',
    from: "       AND ($3 OR high_risk_at IS NULL)",
    to: "       AND ($3 OR TRUE)",
  },
  {
    id: 'M325', file: 'backend/domains/payment/paymentOrder.routes.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'the Payment Control Centre decides a dispute and suspends nobody (§32 S3)',
    from: "    // After the money: the suspension narrates a decision that has committed\n    // and its money that has moved (§21), and must not stand in front of them.\n    await recordDisputeLoser(asDecided, outcome);",
    to: "    // removed",
  },
  {
    id: 'M326', file: 'backend/domains/payment/paymentOrder.routes.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'the queue action decides a dispute and suspends nobody (§32 S3)',
    from: "    if (wasDispute) {\n      await recordDisputeLoser(order, {",
    to: "    if (false) {\n      await recordDisputeLoser(order, {",
  },
  {
    id: 'M327', file: 'backend/domains/disputes/disputeResolution.admin.routes.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'the Dispute Manager decides a dispute and suspends nobody',
    from: "    const fault = await recordDisputeLoser(asDecided, outcome);",
    to: "    const fault = { ok: false };",
  },
  {
    id: 'M328', file: 'backend/domains/configuration/tokenRates.js', config: UNIT,
    test: 'backend/tests/unit/tokenRates.test.js',
    why: 'the team pool USDT rate is read with no sanity band',
    from: "  const rate = config?.usdtPricing?.merchantAdminBuyInr;\n  return isUsableRate(rate) && isSaneUsdtRate(rate) ? Number(rate) : null;",
    to: "  const rate = config?.usdtPricing?.merchantAdminBuyInr;\n  return isUsableRate(rate) ? Number(rate) : null;",
  },
  // ── A member's own switches reach the router (2c) ────────────────────────
  {
    id: 'M329', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'backend/tests/routes/merchantPanelRoutes.test.js',
    why: 'a member who switched "Accept deposit orders" off is told it saved and keeps being handed buys — the preference has no consumer',
    from: "        AND (CASE WHEN $3 THEN m.accepts_deposits ELSE m.accepts_withdrawals END)\n",
    to: "\n",
  },
  // ── Security review 2026-10-03, F1: a buy's money moved before its state ──
  {
    id: 'M330', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a confirm that read PAID pays the team\'s tokens out on a buy a member rejected or an expiry cancelled meanwhile',
    from: "      if (states && !states.includes(o[0].state)) throw new Refused('order_state');\n",
    to: "\n",
  },
  {
    id: 'M331', file: 'backend/domains/payment/depositCredit.js', config: PG,
    test: 'backend/tests/routes/paymentOrderAdminActionRoutes.test.js',
    why: 'the state the route read never reaches the spend, so the check under the lock asks nothing',
    from: "  const taken = await complete(order.orderId, { actor: 'deposit-credit', requireState });\n",
    to: "  const taken = await complete(order.orderId, { actor: 'deposit-credit' });\n",
  },
  {
    id: 'M332', file: 'database/repositories/teamPools.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a buy whose tokens were paid out can still be rejected, cancelled or disputed before the confirm completes it',
    from: "      await client.query('UPDATE order_states SET pool_paid_at = now() WHERE order_id = $1', [oid]);\n",
    to: "\n",
  },
  {
    id: 'M333', file: 'database/repositories/orders.core.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'the paid-out rule is not asked under the lock, so the caller is told an illegal move rather than why',
    from: "    if (order.poolPaidAt && to !== ORDER_STATES.COMPLETED && order.state !== ORDER_STATES.COMPLETED) {\n",
    to: "    if (false) {\n",
  },
  {
    id: 'M334', file: 'backend/domains/payment/paymentOrder.routes.js', config: PG,
    test: 'backend/tests/routes/paymentOrderAdminActionRoutes.test.js',
    why: 'an admin APPROVE on a REJECTED buy credits the player and spends the pool, then answers 409',
    from: "    if (action === 'APPROVE' && !canTransition(order.status, 'COMPLETED')) {\n",
    to: "    if (false) {\n",
  },
  // ── Security review 2026-10-03, F2: suspended for a dispute nobody lost ───
  {
    id: 'M335', file: 'backend/domains/disputes/disputeOutcome.service.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a member\'s red flag decided against the player suspends a player who claimed nothing',
    from: "  if (!['user', 'system'].includes(order.disputeRaisedBy)) return null;\n",
    to: "\n",
  },
  {
    id: 'M336', file: 'backend/domains/disputes/disputeOutcome.service.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'dismissing a dispute on a buy that had already completed suspends the member who confirmed it',
    from: "  if (!PAYMENT_DISPUTE_FROM[order.type]?.includes(disputedFrom)) return null;\n",
    to: "\n",
  },
  {
    id: 'M337', file: 'backend/domains/disputes/disputeOutcome.service.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a cash buy disputed because the player sent no reference suspends the member who was shown nothing',
    from: "    return disputedFrom === 'REJECTED' || order.utr ? FAULT_PARTIES.MERCHANT : null;\n",
    to: "    return FAULT_PARTIES.MERCHANT;\n",
  },
  {
    id: 'M338', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a member red-flags their own rejection, turning it into a dispute the player never raised',
    from: "        if (order.status === 'REJECTED') {\n",
    to: "        if (false) {\n",
  },
  {
    id: 'M339', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a red flag is not recorded as the member\'s, so the record cannot say whose report it was',
    from: "                disputeRaisedBy: 'merchant',\n",
    to: "\n",
  },
  // ── Security review 2026-10-03, F3 and F4 ─────────────────────────────────
  {
    id: 'M340', file: 'database/repositories/orders.core.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a member accepts or declines an order an admin handed to a colleague, and their write takes it back',
    from: "    if (onlyMerchant && String(order.merchantId ?? '') !== String(onlyMerchant)) {\n",
    to: "    if (false) {\n",
  },
  {
    id: 'M341', file: 'database/repositories/orders.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'the member a route acts as never reaches the writer, so the pin asks nothing',
    from: "    txId: key, within, onlyFrom: expectFrom, onlyMerchant: expectMerchant,\n",
    to: "    txId: key, within, onlyFrom: expectFrom,\n",
  },
  {
    id: 'M342', file: 'database/repositories/config.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'an operator saves 7.5 minutes, is told it saved, and the platform runs the default',
    from: "      if (field.integer && !Number.isInteger(num)) throw",
    to: "      if (false) throw",
  },
  {
    id: 'M343', file: 'database/repositories/disputeFaults.js', config: PG,
    test: 'backend/tests/routes/disputeFaultsPg.test.js',
    why: 'a high-risk review re-opened after an admin closed it raises no alert',
    from: "      return { ok: true, party, lostCount, highRisk, newlyHighRisk: loser[0].newly_high_risk === true };\n",
    to: "      return { ok: true, party, lostCount, highRisk, newlyHighRisk: highRisk && lostCount === HIGH_RISK_LOSSES };\n",
  },
  // ── Step 2d: a cash buy is paid through the machine the member scans ──
  {
    id: 'M349', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'a member scans a ₹5,000 QR for a ₹1,000 order and the player pays five times the order',
    from: "  if (Math.round(Number(am) * 100) !== want) {\n",
    to: "  if (false) {\n",
  },
  {
    id: 'M350', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'a link naming the amount twice is checked on one and paid on the other',
    from: "    if (seen.has(key)) throw refuse(",
    to: "    if (false) throw refuse(",
  },
  {
    id: 'M351', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'any QR, a website or a script, is handed to the player as the thing to pay',
    from: "  if (scanned.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {\n",
    to: "  if (false) {\n",
  },
  {
    id: 'M352', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a member the order moved away from still puts their machine\'s QR in front of the player',
    from: "        AND merchant_id  = $2\n        AND order_type   = 'DEPOSIT'\n",
    to: "        AND order_type   = 'DEPOSIT'\n",
  },
  {
    id: 'M353', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'the QR is swapped after the player paid it, and the order no longer says what was paid',
    from: "        AND payment_mode = 'CASH_ATM'\n        AND state        = 'PROCESSING'\n",
    to: "        AND payment_mode = 'CASH_ATM'\n",
  },
  {
    id: 'M354', file: 'database/repositories/teamRouting.js', config: PG,
    test: 'database/tests/teamRoutingPg.test.js',
    why: 'a bank-transfer buy goes to a member with no bank account, and the player is shown nowhere to pay',
    from: "        AND (NOT ($3 AND $1 = 'UPI_BANK') OR (\n",
    to: "        AND (true OR (\n",
  },
  {
    id: 'M355', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a player says they paid a cash buy before there was anything to pay',
    from: "  if (isCashRail && !order.cashLink) {\n",
    to: "  if (false) {\n",
  },
  {
    id: 'M356', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a Paid tap racing a change of hands leaves the cash buy PAID with no QR, paid to nobody\'s machine',
    from: "  const sameMember = order.merchantId;\n",
    to: "  const sameMember = null;\n",
  },
  {
    id: 'M357', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a player who was never given a QR is counted as not paying, and locked out after three',
    from: "            playerCouldPay: !neverAccepted && !noCashLink,\n",
    to: "            playerCouldPay: !neverAccepted,\n",
  },
  {
    id: 'M358', file: 'backend/domains/payment/playerPaymentFailure.service.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'the expiry sweep says the player could not pay, and the count moves anyway',
    from: "  const player = playerCouldPay\n",
    to: "  const player = true\n",
  },
  {
    id: 'M359', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'an order moves to another member and the player is still shown the last member\'s machine',
    from: "  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id THEN\n    NEW.cash_link := NULL;",
    to: "  IF false THEN\n    NEW.cash_link := NULL;",
  },
  {
    id: 'M360', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'the member scans the machine and the player is never given the Pay button',
    from: "    if (order.cashLink) view.paymentLink = order.cashLink;\n",
    to: "    if (false) view.paymentLink = order.cashLink;\n",
  },
  {
    id: 'M361', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'a 50,000 buy shows the player no bank account to transfer to',
    from: "  } else if (isBuy && order.currency !== 'USDT' && snapshot.accountNo) {\n",
    to: "  } else if (false) {\n",
  },
  {
    id: 'M362', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the player is sent the member\'s whole profile, UPI handle included, instead of the account',
    from: "    for (const key of PLAYER_PAY_TO_BANK_FIELDS) {\n",
    to: "    for (const key of Object.keys(snapshot)) {\n",
  },
  {
    id: 'M363', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a member is invited to scan a machine for a sell, and told the order is closed instead',
    from: "        if (order.type !== 'DEPOSIT' || order.paymentMode !== PAYMENT_MODES.CASH_ATM) {\n",
    to: "        if (false) {\n",
  },
  {
    id: 'M364', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'a member scans their own UPI QR instead of the machine\'s, and the player\'s app shows them the member\'s mobile number',
    from: "  if (MOBILE_IN_HANDLE.test(payee.split('@')[0])) {\n",
    to: "  if (false) {\n",
  },
  {
    id: 'M365', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a member saves their Paytm account, and every player paying a big buy is shown the member\'s mobile number',
    from: "  SELECT (bare ~ '^[6-9][0-9]{9}$'\n          AND bank IN",
    to: "  SELECT (false\n          AND bank IN",
  },
  {
    id: 'M366', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a player gives their own mobile as their account number at a regular bank, and the member paying their sell sees it',
    from: "      OR (length(own) = 10 AND bare = own)\n",
    to: "      OR false\n",
  },
  {
    id: 'M367', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'every ten-digit account is taken for a phone number, so a Kotak customer cannot be paid',
    from: "          AND bank IN ('PYTM', 'AIRP', 'JIOP', 'FINO', 'NSPB', 'IPOS'))\n",
    to: "          AND true)\n",
  },
  {
    id: 'M370', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a member types their mobile into the account holder name, and every player paying them reads it',
    from: "     AND NOT bb_text_has_a_mobile(bank_account_holder_name)\n",
    to: "",
  },
  {
    id: 'M371', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a payments-bank account typed with a stray space before the IFSC is taken for a regular bank, and shows the mobile',
    from: "           upper(left(regexp_replace(COALESCE(ifsc, ''), '[^A-Za-z0-9]', '', 'g'), 4)) AS bank\n",
    to: "           upper(left(COALESCE(ifsc, ''), 4)) AS bank\n",
  },
  {
    id: 'M372', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'the player is shown the member\'s account while the member may still decline, pays it, and the order goes to someone else',
    from: "  const accepted = PAY_DETAIL_STATES.includes(order.status);\n",
    to: "  const accepted = true;\n",
  },
  {
    id: 'M373', file: 'backend/domains/payment/playerOrderView.js', config: PG,
    test: 'backend/tests/routes/playerOrderPrivacyRoutes.test.js',
    why: 'USDT is sent to a member who has not accepted, and declines: a chain payment nobody can reverse',
    from: "  if (accepted && isBuy && snapshot.usdtPayTo && snapshot.usdtChain) {\n",
    to: "  if (isBuy && snapshot.usdtPayTo && snapshot.usdtChain) {\n",
  },
  {
    id: 'M374', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/acceptBeforePayPg.test.js',
    why: '"I\'ve paid" on a buy nobody accepted spends the player\'s reference on an order that cannot move',
    from: "  if (order.status === 'ASSIGNED') {\n    throw Object.assign(\n      new Error('The member has not accepted",
    to: "  if (false) {\n    throw Object.assign(\n      new Error('The member has not accepted",
  },
  {
    id: 'M375', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/acceptBeforePayPg.test.js',
    why: 'a bank buy changes hands while the tap waits, and reads PAID to the new member for money sent to the old one',
    from: "  const sameMember = order.merchantId;\n",
    to: "  const sameMember = isCashRail ? order.merchantId : undefined;\n",
  },
  {
    id: 'M376', file: 'backend/domains/payment/paymentProcessing.service.js', config: PG,
    test: 'backend/tests/routes/acceptBeforePayPg.test.js',
    why: 'a player is counted as not paying a buy that was never accepted, when there was nothing to pay',
    from: "          const neverAccepted = order.status === 'ASSIGNED';\n",
    to: "          const neverAccepted = false;\n",
  },
  {
    id: 'M377', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/cashLinkPg.test.js',
    why: 'a member who has not accepted is told the order is closed, not to accept it first',
    from: "        if (order.status === 'ASSIGNED') {\n            // The player is shown the QR only",
    to: "        if (false) {\n            // The player is shown the QR only",
  },
  {
    id: 'M378', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'a person\'s QR with their number in its name is handed to the player, whose UPI app shows it',
    from: "  if (['pn', 'tn'].some((key) => textHasAMobile(seen.get(key) ?? ''))) {\n",
    to: "  if (false) {\n",
  },
  {
    id: 'M379', file: 'backend/domains/payment/cashLink.js', config: UNIT,
    test: 'backend/tests/unit/cashLink.test.js',
    why: 'a handle written 0091 and a mobile is taken for a machine\'s',
    from: "const MOBILE_IN_HANDLE = /(?:^|\\D)(?:0{0,2}91|0)?[6-9]\\d{9}(?:\\D|$)/;\n",
    to: "const MOBILE_IN_HANDLE = /(?:^|\\D)(?:91|0)?[6-9]\\d{9}(?:\\D|$)/;\n",
  },
  {
    id: 'M380', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a player types their mobile into the account holder name, and the member paying them reads it',
    from: "     AND NOT bb_text_has_a_mobile(bank_details->>'accountHolderName')\n",
    to: "",
  },
  {
    id: 'M381', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a mobile number typed into the bank name reaches the other side of every order',
    from: "     AND NOT bb_text_has_a_mobile(bank_details->>'bankName'));\n",
    to: ");\n",
  },
  {
    id: 'M382', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a payments-bank account written with 0091 in front is taken for a regular account, and shows the mobile',
    from: "digits ~ '^(0{0,2}91|0)[6-9][0-9]{9}$'",
    to: "digits ~ '^(91|0)[6-9][0-9]{9}$'",
  },
  {
    id: 'M368', file: 'backend/domains/user/user.routes.js', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'a player whose account is refused is told only that saving failed, with nothing to change',
    from: "    if (isAccountMobileRefusal(error)) {\n",
    to: "    if (false) {\n",
  },
  {
    id: 'M369', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/payoutAccountNotAMobilePg.test.js',
    why: 'an applicant whose account is a mobile number is told "signup failed" and nothing they can act on',
    from: "    if (error.code === '23514' && error.constraint === 'merchants_bank_account_not_a_mobile') {\n",
    to: "    if (false) {\n",
  },  // ── Team commission (Step 2e) ──────────────────────────────────────────────
  {
    id: 'M383', file: 'database/repositories/teamCommission.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'a commission the platform pool cannot cover is paid anyway: the pool is overdrawn, and the platform pays more than it set aside (§26: never partial)',
    from: `      if (poolPaise < amount) return { ok: false, reason: 'pool_short', owedPaise: amount, poolPaise, summary };\n`,
    to: '',
  },
  {
    id: 'M384', file: 'database/repositories/teamCommission.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'matched volume is the LARGER side: a team that only buys is paid commission on volume nobody matched',
    from: `  const matched = Math.min(buys, sells);`,
    to: `  const matched = Math.max(buys, sells);`,
  },
  {
    id: 'M385', file: 'database/repositories/teamCommission.js', config: UNIT,
    test: 'backend/tests/unit/teamCommission.test.js',
    why: 'the supervisor is recorded 10% of a payment instead of the owner\'s 16%',
    from: `  const supervisorShare = Math.floor((total * SUPERVISOR_SHARE_PERCENT) / 100);`,
    to: `  const supervisorShare = Math.floor((total * 10) / 100);`,
  },
  {
    id: 'M386', file: 'backend/domains/payment/orderLifecycle.service.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'a buy that completes the match pays nothing until the sweep: commission is no longer instant',
    from: `  if (to === ORDER_STATES.COMPLETED && result.ok && result.order?.teamId) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M387', file: 'backend/domains/payment/withdrawalHold.service.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'a sell that completes the match pays nothing until the sweep: commission is no longer instant',
    from: `  await payCommissionFor(order.teamId, { actor: 'settlement-worker' });\n`,
    to: '',
  },
  {
    id: 'M388', file: 'database/repositories/teamPools.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'commission tokens are taken from the commission token pool instead of the platform holding, which nothing funds',
    from: `    legs: { [ACCOUNTS.TOKEN_SUPPLY]: -paise, [ACCOUNTS.TEAM_FLOAT]: paise },`,
    to: `    legs: { [ACCOUNTS.COMMISSION_POOL]: -paise, [ACCOUNTS.TEAM_FLOAT]: paise },`,
  },
  {
    id: 'M389', file: 'database/repositories/teamCommission.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'the mark is read as the LOWEST mark paid, so the same rise is paid again on the next ask',
    from: `  SELECT COALESCE(MAX(to_high_paise), 0) AS high_paise,`,
    to: `  SELECT COALESCE(MIN(to_high_paise), 0) AS high_paise,`,
  },
  {
    id: 'M390', file: 'database/repositories/teamCommission.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'a member is shown the largest share of each payment — the supervisor\'s — instead of their own',
    from: `                       WHERE s.commission_id = c.commission_id AND s.merchant_id = $2), 0) AS my_share_paise`,
    to: `                       WHERE s.commission_id = c.commission_id AND $2::text IS NOT NULL ORDER BY s.share_paise DESC LIMIT 1), 0) AS my_share_paise`,
  },
  {
    id: 'M391', file: 'backend/domains/revenue/revenue.admin.routes.js', config: PG,
    test: 'backend/tests/routes/teamCommissionPg.test.js',
    why: 'funding the commission pool leaves the commission it was waiting on unpaid until the next sweep',
    from: `    const paidNow = result.idempotent ? [] : (await payOwedCommissions({ actor: \`admin:\${req.user.userId}\` })`,
    to: `    const paidNow = true ? [] : (await payOwedCommissions({ actor: \`admin:\${req.user.userId}\` })`,
  },
  // ── Step 2f: red flags and oversight ─────────────────────────────────────
  {
    id: 'M392', file: 'database/repositories/teamOversight.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'a member below the team in only ONE of orders and online time is red-flagged (the owner said both)',
    from: `    .filter((m) => m.completedOrders < orderCut && m.onlineSeconds < onlineCut)`,
    to: `    .filter((m) => m.completedOrders < orderCut || m.onlineSeconds < onlineCut)`,
  },
  {
    id: 'M393', file: 'database/repositories/teamOversight.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'the threshold is read the wrong way round: 25% below the average becomes 75% below it',
    from: `  const keep = (100 - Number(percent)) / 100;`,
    to: `  const keep = Number(percent) / 100;`,
  },
  {
    id: 'M397', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'switching Online off never closes the stretch, so online time runs on while the member is offline',
    from: `    UPDATE merchant_online_sessions SET ended_at = GREATEST(started_at, clock_timestamp())
     WHERE merchant_id = NEW.merchant_id AND ended_at IS NULL;`,
    to: `    NULL;`,
  },
  {
    id: 'M398', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor\'s dispute message may carry a mobile number',
    from: `  CHECK (sender_type <> 'SUPERVISOR' OR NOT bb_text_has_a_mobile(message));`,
    to: `  CHECK (sender_type <> 'SUPERVISOR' OR TRUE);`,
  },
  {
    id: 'M399', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor can read and post in a dispute on another supervisor\'s team',
    from: `      WHERE os.order_id = $1 AND os.dispute_raised_at IS NOT NULL
        AND os.team_id IN (SELECT team_id FROM teams WHERE supervisor_id = $2)`,
    to: `      WHERE os.order_id = $1 AND os.dispute_raised_at IS NOT NULL
        AND $2::text IS NOT NULL`,
  },
  {
    id: 'M400', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor can read the log of another supervisor\'s member',
    from: `      WHERE tm.merchant_id = $1 AND t.supervisor_id = $2`,
    to: `      WHERE tm.merchant_id = $1 AND $2::text IS NOT NULL`,
  },
  {
    id: 'M402', file: 'backend/domains/team/team.merchant.routes.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a member is sent every teammate\'s orders and online time instead of the team\'s totals and their own',
    from: `? teamPerformanceFor(week, me.merchantId) : null,`,
    to: `? week : null,`,
  },
  {
    id: 'M403', file: 'backend/domains/team/team.merchant.routes.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a mobile number a player typed into their dispute reason reaches the supervisor',
    from: `    res.json({ success: true, disputes: toSupervisorOrderViews(disputes.map(withTextHidden)) });`,
    to: `    res.json({ success: true, disputes: toSupervisorOrderViews(disputes) });`,
  },
  {
    id: 'M404', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a day already evaluated is evaluated again',
    from: `    if (!claimed.rowCount) return { evaluated: false };`,
    to: `    if (false) return { evaluated: false };`,
  },
  {
    id: 'M405', file: 'database/repositories/chat.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor can still post into a dispute after it has been decided',
    from: `        WHERE os.order_id = $1 AND os.state = 'DISPUTED'`,
    to: `        WHERE os.order_id = $1 AND TRUE`,
  },
  // ── Step 2f security review: what reaches a supervisor, every mobile spelling ──
  {
    id: 'M406', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'switching Online off ends a stretch before it began, and the CHECK fails the switch itself',
    from: `SET ended_at = GREATEST(started_at, clock_timestamp())`,
    to: `SET ended_at = now()`,
  },
  {
    id: 'M407', file: 'backend/domains/team/team.merchant.routes.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'the player\'s own messages in the dispute thread, UPI handle and all, reach the supervisor',
    from: `      messages: messages.filter(supervisorMaySee).map(toThreadMessage),`,
    to: `      messages: messages.map(toThreadMessage),`,
  },
  {
    id: 'M408', file: 'backend/domains/team/teamOversight.service.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'system notices naming the staff member who decided reach the supervisor',
    from: `  return !message.isSystem && (message.senderType === 'ADMIN' || message.senderType === 'MERCHANT');`,
    to: `  return (message.senderType === 'ADMIN' || message.senderType === 'MERCHANT');`,
  },
  {
    id: 'M409', file: 'backend/domains/team/teamOversight.service.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'a UPI handle a player typed into their dispute reaches the supervisor',
    from: `    .replace(HANDLE, '[handle hidden]')\n`,
    to: ``,
  },
  {
    id: 'M410', file: 'backend/domains/team/teamOversight.service.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'a player\'s UTR or account number reaches the supervisor',
    from: `    .replace(LONG_NUMBER, '[number hidden]');`,
    to: `;`,
  },
  {
    id: 'M411', file: 'database/repositories/chat.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor posts without limit and buries the dispute manager\'s messages past what a thread lists',
    from: `              WHERE c.order_id = $1 AND c.sender_type = 'SUPERVISOR') < $4`,
    to: `              WHERE c.order_id = $1 AND c.sender_type = 'SUPERVISOR') < $4 + 1000`,
  },
  {
    id: 'M412', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a merchant signs up with their mobile as their username, and their supervisor and team read it',
    from: `  CHECK (NOT bb_text_has_a_mobile(name) AND NOT bb_text_has_a_mobile(username));`,
    to: `  CHECK (true);`,
  },
  {
    id: 'M413', file: 'database/repositories/teams.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a mobile in a team name reaches the row\'s CHECK and the supervisor is answered with a server error',
    from: `  if (textHasAMobile(clean)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M414', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a team name carrying a mobile is written by a path that skips the repository',
    from: `ALTER TABLE teams ADD CONSTRAINT teams_name_not_a_mobile CHECK (NOT bb_text_has_a_mobile(name));`,
    to: `ALTER TABLE teams ADD CONSTRAINT teams_name_not_a_mobile CHECK (true);`,
  },
  {
    id: 'M415', file: 'database/schema.sql', config: PG,
    test: 'database/tests/mobileInTextPg.test.js',
    why: 'a mobile written in Hindi digits passes every row check',
    from: `                   '012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789')`,
    to: `                   '０１２３４５６７８９٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹०१२३४५६७८९০১২৩৪৫৬৭৮৯੦੧੨੩੪੫੬੭੮੯૦૧૨૩૪૫૬૭૮૯୦୧୨୩୪୫୬୭୮୯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯')`,
  },
  {
    id: 'M416', file: 'database/schema.sql', config: PG,
    test: 'database/tests/mobileInTextPg.test.js',
    why: 'a mobile written with two spaces, a slash or brackets passes every row check',
    from: `[6-9]([^0-9A-Za-z]{0,2}[0-9]){9}([^0-9]|$)'`,
    to: `[6-9]([ .-]?[0-9]){9}([^0-9]|$)'`,
  },
  {
    id: 'M417', file: 'backend/domains/identity/mobileInText.js', config: UNIT,
    test: 'backend/tests/unit/mobileInText.test.js',
    why: 'a mobile written in Hindi digits is not seen, so it is shown and accepted',
    from: `  return String(text).replace(NON_ASCII_DIGIT, (d) => TO_ASCII.get(d));`,
    to: `  return String(text);`,
  },
  {
    id: 'M418', file: 'backend/domains/identity/mobileInText.js', config: UNIT,
    test: 'backend/tests/unit/mobileInText.test.js',
    why: 'a mobile written with two spaces, a slash or brackets is not seen',
    from: `[6-9](?:[^0-9A-Za-z]{0,2}[0-9]){9}(?![0-9])';`,
    to: `[6-9](?:[ .-]?[0-9]){9}(?![0-9])';`,
  },
  {
    id: 'M419', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor reads the online history of a merchant they have only proposed',
    from: `t.supervisor_id = $2 AND tm.status = 'APPROVED'`,
    to: `t.supervisor_id = $2`,
  },
  {
    id: 'M420', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor reads a member\'s online time from before they joined, perhaps under another supervisor',
    from: `        AND COALESCE(ended_at, now()) > COALESCE($4::timestamptz, '-infinity')`,
    to: `        AND TRUE`,
  },
  {
    id: 'M421', file: 'backend/domains/team/teamOversight.service.js', config: UNIT,
    test: 'backend/tests/unit/teamOversight.test.js',
    why: 'in a team of two, the team total less your own figures is your teammate\'s',
    from: `    team: n < TEAM_FIGURES_FROM ? null : {`,
    to: `    team: false ? null : {`,
  },
  {
    id: 'M422', file: 'backend/domains/team/team.merchant.routes.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a merchant only proposed for a team is shown the team\'s figures',
    from: `      performance: membership.member.status === 'APPROVED' ? `,
    to: `      performance: true ? `,
  },
  {
    id: 'M423', file: 'database/repositories/teamOversight.js', config: PG,
    test: 'backend/tests/routes/teamOversightPg.test.js',
    why: 'a supervisor is shown the red flags of another supervisor\'s members',
    from: `      WHERE ($1::text IS NULL OR t.supervisor_id = $1)`,
    to: `      WHERE ($1::text IS NULL OR TRUE)`,
  },
  // ── 2g review (2026-10-04): the merchant door named an unknown mobile ───
  {
    id: 'M424', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/threeSeparateEntities.test.js',
    why: 'the merchant login answers an unknown mobile differently from a wrong password, so anybody can learn which numbers are merchants',
    from: `        if (!merchant)
            return res.status(401).json({ success: false, message: 'Invalid credentials' });`,
    to: `        if (!merchant)
            return res.status(401).json({ success: false, message: 'No merchant account found for this mobile number' });`,
  },
  // ── "Payment not received" on a PAID buy only (owner, 2026-10-07) ──────────
  {
    id: 'M425', file: 'database/repositories/orders.core.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the state machine lets an unpaid buy into REJECTED again, so a member rejects an accepted buy and the player is warned and flagged',
    from: '  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PAID],',
    to: '  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID],',
  },
  {
    id: 'M426', file: 'database/repositories/orders.core.js', config: UNIT,
    test: 'backend/tests/unit/orderLifecycle.test.js',
    why: 'the rule table admits REJECTED from PROCESSING, before the player tapped Paid',
    from: '  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PAID],',
    to: '  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PROCESSING, ORDER_STATES.PAID],',
  },
  {
    id: 'M427', file: 'backend/domains/payment/rejectedBuyWindow.service.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'an unpaid buy is not told "not yet": both doors let the member write the accusation and stage the proof for a reject the database then refuses',
    from: '  if (canTransition(order.status, ORDER_STATES.REJECTED)) return null;\n',
    to: '  return null;\n',
  },
  {
    id: 'M428', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the reject asks for the reason and verifies the proof before asking whether the buy was paid at all (§32 S34)',
    from: '        const refused = unpaidRejectRefusal(order);\n',
    to: '        const refused = null;\n',
  },
  {
    id: 'M429', file: 'backend/routes/upload.routes.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the proof upload admits a buy the player has not paid, so evidence is staged for an accusation that cannot be made (§32 S3)',
    from: '    const refused = unpaidRejectRefusal(order);\n',
    to: '    const refused = null;\n',
  },
  {
    id: 'M430', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'the transition\'s own refusal is answered with a bare status, so a member whose buy moved on under them is not told where it now stands',
    from: '            const why = unpaidRejectRefusal({ type: order.type, status: rejected.status }) ?? {\n',
    to: '            const why = null ?? {\n',
  },
  {
    id: 'M431', file: 'backend/domains/payment/rejectedBuyWindow.service.js', config: PG,
    test: 'backend/tests/routes/rejectedBuyWindowPg.test.js',
    why: 'a PAID sell is rejected as unpaid: the member who owes the payout calls it the player\'s missing payment',
    from: "  if (order.type !== 'DEPOSIT') {\n    return { status: 400, code: 'NOT_A_BUY'",
    to: "  if (false) {\n    return { status: 400, code: 'NOT_A_BUY'",
  },
  // ── TOKEN CONSERVATION, ENFORCED BY THE DATABASE (owner, 2026-10-07) ──────
  // Each guard below is the database refusing a transaction, so the mutation is
  // in `schema.sql` itself: `applySchema()` runs the whole file on every suite
  // start, and each guard is DROPped and re-ADDed there (S31), so weakening the
  // definition weakens the live database the next time a suite starts.
  {
    id: 'MC1', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a pocket may go below zero again — a token spent that was never there',
    from: `ALTER TABLE wallets ADD CONSTRAINT wallets_pockets_nonneg CHECK (
  deposit_paise >= 0 AND winnings_paise >= 0 AND token_paise >= 0
  AND reserve_paise >= 0 AND locked_paise >= 0);`,
    to: `ALTER TABLE wallets ADD CONSTRAINT wallets_pockets_nonneg CHECK (true);`,
  },
  {
    id: 'MC2', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a lock may claim to come from a pocket it never came from',
    from: `ALTER TABLE wallets ADD CONSTRAINT wallets_lock_provenance_nonneg CHECK (
  locked_deposit_paise >= 0 AND locked_winnings_paise >= 0);`,
    to: `ALTER TABLE wallets ADD CONSTRAINT wallets_lock_provenance_nonneg CHECK (true);`,
  },
  {
    id: 'MC3', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'TOKEN_SUPPLY may hold tokens it never released, and a platform account may hold fewer than none',
    from: `ALTER TABLE treasury_accounts ADD CONSTRAINT treasury_accounts_sign CHECK (
  CASE WHEN account = 'TOKEN_SUPPLY' THEN balance_paise <= 0 ELSE balance_paise >= 0 END);`,
    to: `ALTER TABLE treasury_accounts ADD CONSTRAINT treasury_accounts_sign CHECK (true);`,
  },
  {
    id: 'MC4', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'the platform may release more tokens than SystemConfig.adminTokenSupply.total says exist',
    from: `     AND 0 - NEW.balance_paise > bb_token_supply_paise() THEN`,
    to: `     AND false THEN`,
  },
  {
    id: 'MC5', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'the wallets may move by more than USER_FLOAT — tokens in a wallet the treasury does not have there',
    from: `  off := bb_cons_bucket('wallets');
  IF off <> 0 THEN`,
    to: `  off := bb_cons_bucket('wallets');
  IF false THEN`,
  },
  {
    id: 'MC6', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'the team pools may move by more than TEAM_FLOAT',
    from: `  off := bb_cons_bucket('pools');
  IF off <> 0 THEN`,
    to: `  off := bb_cons_bucket('pools');
  IF false THEN`,
  },
  {
    id: 'MC7', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a pool\'s available tokens may move with no entry explaining it',
    from: `  off := bb_cons_bucket('pool_available');
  IF off <> 0 THEN`,
    to: `  off := bb_cons_bucket('pool_available');
  IF false THEN`,
  },
  {
    id: 'MC8', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a pool\'s HELD tokens may move with no entry explaining it',
    from: `  off := bb_cons_bucket('pool_held');
  IF off <> 0 THEN`,
    to: `  off := bb_cons_bucket('pool_held');
  IF false THEN`,
  },
  {
    id: 'MC9', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a treasury balance may move without the entries that explain it',
    from: `    off := bb_cons_bucket('acct_' || lower(account));
    IF off <> 0 THEN`,
    to: `    off := bb_cons_bucket('acct_' || lower(account));
    IF false THEN`,
  },
  {
    id: 'MC10', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'a movement\'s legs need not sum to zero, so tokens can appear',
    from: `  SELECT SUM(amount_paise) INTO total FROM treasury_entries WHERE movement_id = NEW.movement_id;
  IF total <> 0 THEN`,
    to: `  SELECT SUM(amount_paise) INTO total FROM treasury_entries WHERE movement_id = NEW.movement_id;
  IF false THEN`,
  },
  {
    id: 'MC11', file: 'database/schema.sql', config: PG,
    test: 'database/tests/conservationPg.test.js',
    why: 'wallet movements stop being tracked, so the check compares USER_FLOAT against nothing',
    from: `  PERFORM bb_cons_add('wallets', d);`,
    to: `  PERFORM bb_cons_add('wallets', 0);`,
  },
  {
    id: 'MC12', file: 'database/repositories/wallets.core.js', config: PG,
    test: 'database/tests/walletPg.test.js',
    why: 'a wallet movement need not say where the tokens came from, so the refusal arrives as a COMMIT error instead of an answer',
    from: `function requireCounterparty(counterparty, delta) {
  if (delta === 0) return;`,
    to: `function requireCounterparty(counterparty, delta) {
  if (delta === 0 || counterparty || !counterparty) return;`,
  },
  {
    id: 'MC13', file: 'database/repositories/treasury.js', config: PG,
    test: 'database/tests/casinoSettlementBonusPg.test.js',
    why: 'an account paying out tokens it does not hold raises a CHECK error instead of a refusal the caller can phrase',
    from: `      if (after < 0) {
        await client.query(rollback);`,
    to: `      if (false) {
        await client.query(rollback);`,
  },
  // ── A casino WIN pays into winnings (owner, 2026-10-07) ──────────────────
  // The pocket each callback moves is `CALLBACK_POCKET` in casino.core.js. A
  // stake goes back where the BET took it; only a WIN reaches winnings.
  {
    id: 'MCW1', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'a casino WIN is paid into the deposit again, so it cannot be withdrawn the way a board win can',
    from: `  [CASINO_TX.WIN]:      'winningsBalance',`,
    to: `  [CASINO_TX.WIN]:      STAKE_POCKET,`,
  },
  {
    id: 'MCW2', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'a ROLLBACK returns the stake into winnings: a BET and its rollback turn a deposit into withdrawable money',
    from: `  [CASINO_TX.ROLLBACK]: STAKE_POCKET,`,
    to: `  [CASINO_TX.ROLLBACK]: 'winningsBalance',`,
  },
  {
    id: 'MCW3', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'a REFUND returns the stake into winnings: a deposit becomes withdrawable with no game played',
    from: `  [CASINO_TX.REFUND]:   STAKE_POCKET,`,
    to: `  [CASINO_TX.REFUND]:   'winningsBalance',`,
  },
  {
    id: 'MCW4', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'a casino BET takes its stake from winnings instead of the deposit',
    from: `  [CASINO_TX.BET]:      STAKE_POCKET,`,
    to: `  [CASINO_TX.BET]:      'winningsBalance',`,
  },
  {
    id: 'MCW5', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'the ledger row names the deposit while the winnings moved, so History describes a movement that did not happen',
    from: `        field: pocket,`,
    to: `        field: STAKE_POCKET,`,
  },
  {
    // MCW1's edit, measured through the transport: the signed provider
    // callback and the player's History, not the repository alone.
    id: 'MCW6', file: 'database/repositories/casino.core.js', config: PG,
    test: 'backend/tests/routes/casinoWinPocketRoutesPg.test.js',
    why: 'a WIN posted to POST /api/game/wallet/:providerKey lands in the deposit, and History shows it as the deposit wallet',
    from: `  [CASINO_TX.WIN]:      'winningsBalance',`,
    to: `  [CASINO_TX.WIN]:      STAKE_POCKET,`,
  },
  {
    // Two edits, because the callback is idempotent twice over on purpose —
    // the provider id is UNIQUE in casino_transactions and, as `casino_<id>`,
    // in wallet_ledger. Loosening either alone pays nothing twice.
    id: 'MCW7', file: 'database/repositories/casino.core.js', config: PG,
    test: 'database/tests/casinoWinPocketPg.test.js',
    why: 'a redelivered WIN is keyed afresh each time, so the provider retrying pays the winnings again',
    edits: [
      [`        [String(txId), ctx.rid, ctx.uid, ctx.provider, type, amountPaise],`,
        `        [\`\${txId}:\${Math.random()}\`, ctx.rid, ctx.uid, ctx.provider, type, amountPaise],`],
      [`        txId: \`casino_\${txId}\`,`,
        `        txId: \`casino_\${txId}:\${Math.random()}\`,`],
    ],
  },

  // ── The Dispute Manager's queue: one vocabulary, the server's (helper/harness-2) ─
  {
    id: 'M440', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: 'a filter the queue does not know is quietly read as the default, so a screen asking for a state it invented is shown a list instead of being told',
    from: `  const chosen = Object.hasOwn(DISPUTE_FILTERS, key) ? DISPUTE_FILTERS[key] : null;`,
    to: `  const chosen = DISPUTE_FILTERS[key] ?? DISPUTE_FILTERS[DEFAULT_DISPUTE_FILTER];`,
  },
  {
    id: 'M441', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: '"Closed" asks for a recorded decision, so a dispute closed by a refund (which records none) is in no list but "All"',
    from: "  CLOSED:    { label: 'Closed', where: `o.state <> 'DISPUTED' AND ${EVER_DISPUTED}` },",
    to: "  CLOSED:    { label: 'Closed', where: `o.state <> 'DISPUTED' AND o.dispute_decision IS NOT NULL` },",
  },
  {
    id: 'M442', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: '"All disputes" lists only the open ones, so a decided dispute is in the queue nowhere an admin would look for it',
    from: "  ALL:       { label: 'All disputes', where: `(o.state = 'DISPUTED' OR ${EVER_DISPUTED})` },",
    to: "  ALL:       { label: 'All disputes', where: `o.state = 'DISPUTED'` },",
  },
  {
    id: 'M443', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: '"Escalated" lists every open dispute, escalated or not',
    from: "  ESCALATED: { label: 'Open, escalated', where: `o.state = 'DISPUTED' AND o.dispute_escalated` },",
    to: "  ESCALATED: { label: 'Open, escalated', where: `o.state = 'DISPUTED'` },",
  },
  {
    id: 'M444', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: 'the total is the rows on this page, so the 51st dispute is never mentioned and a page past the end says there are none (S47)',
    from: `  const total = rows.length ? Number(rows[0].total_matching) : 0;`,
    to: `  const total = rows.filter((r) => r.order_id).length;`,
  },
  {
    id: 'M445', file: 'database/repositories/orders.record.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: 'the screen opens on every dispute ever raised instead of the work still to do',
    from: `export const DEFAULT_DISPUTE_FILTER = 'OPEN';`,
    to: `export const DEFAULT_DISPUTE_FILTER = 'ALL';`,
  },
  {
    id: 'M446', file: 'backend/domains/disputes/disputeResolution.admin.routes.js', config: PG,
    test: 'backend/tests/routes/disputeQueuePg.test.js',
    why: 'the dispute the dialog opens is the raw order, not the queue\'s view, so it carries no "who would be suspended" and the Resolve tab says nobody is',
    from: `    res.json({ success: true, dispute: toDisputeView(order) });`,
    to: `    res.json({ success: true, dispute: order });`,
  },

  // ── A supervisor takes no orders, so has no online switch (helper/harness-2) ─
  {
    id: 'M447', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'a supervisor goes online, and a member\'s online time is logged for somebody who is not a member (§2)',
    from: `      WHERE merchant_id = $1 AND (NOT $2 OR NOT is_supervisor)`,
    to: `      WHERE merchant_id = $1`,
  },
  {
    id: 'M448', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'the guard refuses a supervisor going OFFLINE too, so a row left online could never be switched off',
    from: `      WHERE merchant_id = $1 AND (NOT $2 OR NOT is_supervisor)`,
    to: `      WHERE merchant_id = $1 AND NOT is_supervisor`,
  },
  {
    id: 'M449', file: 'database/repositories/merchants.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'a supervisor sets order directions on a row routing never reads, and the screen says it saved',
    from: `      WHERE merchant_id = $1 AND NOT is_supervisor`,
    to: `      WHERE merchant_id = $1`,
  },
  {
    id: 'M450', file: 'database/repositories/teams.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'a member online when an admin makes them a supervisor stays online as one, their stretch still open',
    from: `                is_online = is_online AND NOT $2,`,
    to: `                is_online = is_online,`,
  },
  {
    id: 'M451', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'the refusal says "not found" instead of telling the supervisor what they are and who goes online instead (S14)',
    from: `    if (me?.isSupervisor) return res.status(403).json({ success: false, ...SUPERVISOR_TAKES_NO_ORDERS });`,
    to: `    if (me?.isSupervisor) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });`,
  },
  {
    id: 'M452', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'the profile never says the account is a supervisor\'s, so the panel offers the switches the server refuses',
    from: `        isSupervisor:         merchant.isSupervisor === true,`,
    to: `        isSupervisor:         false,`,
  },
  {
    id: 'M453', file: 'backend/domains/merchant/merchant.routes.js', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'the preferences route goes back to the generic patch, which has no supervisor guard',
    from: `        const merchant = await db.merchants.setOrderPreferences(req.merchantId, update);`,
    to: `        const merchant = await db.merchants.updateMerchant(req.merchantId, update);`,
  },
  {
    id: 'M454', file: 'database/repositories/merchants.js', config: PG,
    test: 'database/tests/merchantPg.test.js',
    why: 'the generic patch can write the online switch again: a second writer beside `setOnline`, around its supervisor guard (§3)',
    from: `  'status', 'suspension_reason', 'accepts_deposits', 'accepts_withdrawals',`,
    to: `  'status', 'suspension_reason', 'is_online', 'accepts_deposits', 'accepts_withdrawals',`,
  },
  {
    id: 'M455', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'the row no longer refuses a supervisor online, so any path but `setOnline` (a fixture, a script, the next route) can put one there',
    from: `  CHECK (NOT (is_supervisor AND is_online));`,
    to: `  CHECK (TRUE);`,
  },
  {
    id: 'M456', file: 'database/schema.sql', config: PG,
    test: 'backend/tests/routes/supervisorTakesNoOrdersPg.test.js',
    why: 'a database holding a supervisor online from before the rule is not switched off first, so applying the schema fails on the constraint (§32 S31)',
    from: `UPDATE merchants SET is_online = FALSE, last_online_toggle = now() WHERE is_supervisor AND is_online;`,
    to: `-- (not converged)`,
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
 * M101 was the case that showed it (it went with the cash-link queue in Step
 * 2c). The cash-link claim tested the denomination twice — the size the link
 * was supplied for, and the tier the merchant was on — and both were
 * load-bearing, because an admin could move a merchant between the two moments.
 * A mutation of either one was unkillable by construction, and a test was
 * written against it and still could not kill it, which is how it showed.
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
  // The replacement is a FUNCTION so it is taken literally: a string
  // replacement reads `$'`, `$&` and `$\`` as patterns, and a regex ending in
  // `$'` (a SQL `~ '…$'`) once wrote the rest of the file into the mutant,
  // which then failed to load and read NOT-MEASURED.
  writeFileSync(m.file, edits.reduce((text, [from, to]) => text.replace(from, () => to), original));
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

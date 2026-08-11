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
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const UNIT = 'vitest.config.ts';
const PG = 'vitest.pg.config.ts';

const MUTATIONS = [
  // ── Blocker (a): the winner aggregation's funding provenance ──────────────
  {
    id: 'M1', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'aggregation projects the funding split under an ALIAS again',
    from: `fromDepositBalance:  "$fromDepositBalance",`,
    to: `fromDeposit: "$fromDepositBalance",`,
  },
  {
    id: 'M2', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'fromReserveBalance dropped from the projection again',
    from: `                        fromReserveBalance:  "$fromReserveBalance",\n`,
    to: '',
  },
  {
    id: 'M3', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'locked totals read the OLD alias, so the stake never leaves the counters',
    from: `totalLockedDeposit += bet.fromDepositBalance || 0;`,
    to: `totalLockedDeposit += bet.fromDeposit || 0;`,
  },
  // ── Blocker (b): the bet document travels with the stamp ──────────────────
  {
    id: 'M4', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'betStamps carries no bet document again',
    from: `                    bet: {\n                        _id:    bet.betId,`,
    to: `                    betDoc: {\n                        _id:    bet.betId,`,
  },
  // ── The losing side routes, and the Mongo writes are suppressed ───────────
  {
    id: 'M5', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'unlockLostBet runs on the Postgres branch too — the stake released twice',
    from: `                if (!r.ok) {
                    refusals.push({ betId: String(bet._id), userId: String(bet.userId), outcome: 'LOST', reason: r.reason });
                }`,
    to: `                if (!r.ok) {
                    refusals.push({ betId: String(bet._id), userId: String(bet.userId), outcome: 'LOST', reason: r.reason });
                }
                await unlockLostBet(bet.userId, bet.amount, bet._id, 0, 0);`,
  },
  {
    id: 'M6', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'the bulk LOST stamp runs on both branches — it would overwrite a refusal',
    from: `            await Bet.updateMany(
                { cycleId: cycle.cycleId, side: { $ne: cycle.winner }, status: 'PENDING', isPhantom: false },
                { $set: { status: 'LOST' } }
            );
        }`,
    to: `        }
            await Bet.updateMany(
                { cycleId: cycle.cycleId, side: { $ne: cycle.winner }, status: 'PENDING', isPhantom: false },
                { $set: { status: 'LOST' } }
            );`,
  },
  {
    id: 'M7', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'refusals are collected but never reported',
    from: `        if (refusals.length > 0) {
            console.error(`,
    to: `        if (false) {
            console.error(`,
  },
  {
    id: 'M8', file: 'backend/domains/markets/gameEngine.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementEngineRouting.test.js',
    why: 'the winning side asks the resolver again instead of using the pass decision',
    from: `executeSettlementBatch(userBulkOps, txBulkOps, { onPg })).refused);
                userBulkOps = []`,
    to: `executeSettlementBatch(userBulkOps, txBulkOps)).refused);
                userBulkOps = []`,
  },
  // ── The winning side routes, and the Mongo writes are suppressed ──────────
  {
    id: 'M9', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'the bets are re-stamped under Postgres authority — a refusal made silent',
    from: `    if (!onPg) {
        const stampOps`,
    to: `    if (true) {
        const stampOps`,
  },
  {
    id: 'M10', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'walletAuthority runs on the Postgres branch too — payout credited twice',
    from: `    } else {
        for (const op of userOps) {
            try {`,
    to: `    }
    if (true) {
        for (const op of userOps) {
            try {`,
  },
  {
    id: 'M11', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'the retained fee is not passed, so the cycle total silently reads zero',
    from: `                    platformFeeRupees: s.platformFee,`,
    to: `                    platformFeeRupees: 0,`,
  },
  {
    id: 'M12', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'the caller\'s decision is ignored, so one pass can split across stores',
    from: `export async function executeSettlementBatch(userOps, txOps, { onPg = betsOnPostgres() } = {}) {`,
    to: `export async function executeSettlementBatch(userOps, txOps, _routing = {}) {\n    const onPg = betsOnPostgres();`,
  },
  {
    id: 'M13', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'a refusal is swallowed instead of returned',
    from: `                if (!r.ok) {
                    refused.push({`,
    to: `                if (false) {
                    refused.push({`,
  },
  {
    id: 'M14', file: 'backend/domains/settlement/settlementService.js', config: UNIT,
    test: 'backend/tests/unit/betSettlementRouting.test.js',
    why: 'the Transaction history log is skipped under Postgres authority',
    from: `    if (txOps.length > 0) {`,
    to: `    if (txOps.length > 0 && !onPg) {`,
  },
  // ── The fee, in the store that decides it ─────────────────────────────────
  {
    id: 'M15', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
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
    id: 'M16', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'a fractional or negative fee is accepted and silently truncated',
    from: `  if (!Number.isInteger(platformFeePaise) || platformFeePaise < 0) {
    throw new TypeError(\`\${spec.name}Bet: platformFeePaise must be a non-negative integer, got \${platformFeePaise}\`);
  }`,
    to: '',
  },
  // ── The fee crossing between stores ───────────────────────────────────────
  {
    id: 'M17', file: 'backend/postgres/reverseMirror.js', config: UNIT,
    test: 'backend/tests/unit/betMirrorFee.test.js',
    why: 'the rollback leg drops the fee, so Mongo reports zero platform revenue',
    from: `          ...(platformFee !== undefined ? { platformFee } : {}),`,
    to: '',
  },
  {
    id: 'M18', file: 'backend/postgres/reverseMirror.js', config: UNIT,
    test: 'backend/tests/unit/betMirrorFee.test.js',
    why: 'a legitimate ZERO fee is treated as absent and never written',
    from: `    ...(row.platform_fee_paise !== undefined && row.platform_fee_paise !== null
      ? { platformFee: rupees(row.platform_fee_paise) }
      : {}),`,
    to: `    ...(Number(row.platform_fee_paise) ? { platformFee: rupees(row.platform_fee_paise) } : {}),`,
  },
  {
    id: 'M19', file: 'backend/postgres/dualWrite.js', config: UNIT,
    test: 'backend/tests/unit/betMirrorFee.test.js',
    why: 'phantom bets are mirrored into Postgres again',
    from: `    if (doc.isPhantom) return;`,
    to: '',
  },
  {
    id: 'M20', file: 'backend/postgres/dualWrite.js', config: UNIT,
    test: 'backend/tests/unit/betMirrorFee.test.js',
    why: 'the forward leg drops the fee, so an adopted bet arrives with a zero',
    from: `        Number.isFinite(Number(doc.platformFee)) ? paise(doc.platformFee) : 0,`,
    to: `        0,`,
  },
  // ── The reconcile repair that was destroying what it repaired ─────────────
  {
    id: 'M21', file: 'backend/postgres/dualWrite.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'the mirror stops overwriting on conflict, hiding the backfill hazard',
    from: `             platform_fee_paise = EXCLUDED.platform_fee_paise,`,
    to: '',
  },

  // ── A deposit moves tokens; it must not create or destroy them ────────────
  {
    id: 'M22', file: 'backend/domains/payment/payment.routes.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditConservation.test.js',
    why: 'the merchant is debited the DEPOSIT SHARE while the user is credited the whole amount',
    from: `      merchantId: order.merchantId, amount: total,`,
    to: `      merchantId: order.merchantId, amount: depositCredit,`,
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

  // ── The cutover's step-1 report must count what landed, not what it tried ──
  {
    id: 'M26', file: 'backend/postgres/reconcile.js', config: PG,
    test: 'backend/tests/postgres/lifecycleBackfill.test.js',
    why: 'adoption reports ATTEMPTS again, so a pass that adopted nothing reports a full house',
    from: `    created: landed.size,`,
    to: `    created: attempted.length,`,
  },
  {
    id: 'M27', file: 'backend/postgres/reconcile.js', config: PG,
    test: 'backend/tests/postgres/lifecycleBackfill.test.js',
    why: 'rows that did not land are not reported as such',
    from: `    notAdopted: attempted.length - landed.size,`,
    to: `    notAdopted: 0,`,
  },

  // ── A bet's two identities ────────────────────────────────────────────────
  {
    id: 'M28', file: 'backend/postgres/betPgAuthority.js', config: UNIT,
    test: 'backend/tests/unit/betPgAuthorityRouting.test.js',
    why: 'settlement uses the Mongo id as the Postgres key — every placed bet refused',
    from: `  const betId = await resolveBetId(mongoId);`,
    to: `  const betId = mongoId;`,
  },
  {
    id: 'M29', file: 'backend/postgres/betPgAuthority.js', config: UNIT,
    test: 'backend/tests/unit/betPgAuthorityRouting.test.js',
    why: 'the reverse mirror writes the Postgres key as the Mongo _id — a second document',
    from: `      bet_id: betId, mongo_id: mongoId,`,
    to: `      bet_id: betId, mongo_id: betId,`,
  },
  {
    id: 'M30', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'resolveBetId stops looking at mongo_id, so a placed bet is unreachable',
    from: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 OR mongo_id = $1 LIMIT 1\`,`,
    to: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 LIMIT 1\`,`,
  },

  // ── Money-domain READS follow authority (docs/MONEY_READS_MIGRATION.md) ───
  {
    id: 'M31', file: 'backend/postgres/merchantWalletPgAuthority.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'the eligibility reader ignores the resolver and reads a mirror that may be empty',
    from: `  if (!isPostgresAuthoritative(MONEY_PATHS.MERCHANT_WALLET)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M32', file: 'backend/domains/merchant/merchant.assignment.routes.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'an eligibility gate goes back to reading the Mongo document directly',
    from: `    const balance_pa = await getMerchantTokenBalance(merchant._id);
    if (balance_pa < order.tokenAmount) {`,
    to: `    const balance_pa = merchant.tokenBalance;
    if (merchant.tokenBalance < order.tokenAmount) {`,
  },
];

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
    execSync(`npx vitest run --config ${m.config} ${m.test}`, { stdio: 'pipe', env: process.env });
    outcome = 'SURVIVED';
  } catch {
    outcome = 'KILLED';
  } finally {
    writeFileSync(m.file, original);
  }
  results.push({ ...m, outcome });
  console.log(`${outcome === 'KILLED' ? '✅' : '❌'} ${m.id}  ${outcome.padEnd(9)} ${m.why}`);
}

const survived = results.filter((r) => r.outcome !== 'KILLED');
console.log(`\n${results.length - survived.length}/${results.length} mutations killed.`);
if (survived.length) {
  console.log('SURVIVED (a hole in the suite):');
  for (const s of survived) console.log(`  ${s.id} ${s.file} — ${s.why}`);
  process.exit(1);
}

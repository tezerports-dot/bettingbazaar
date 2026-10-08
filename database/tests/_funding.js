// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Where a TEST's tokens come from.
 *
 * A movement that changes what a wallet HOLDS moves USER_FLOAT with it, in the
 * same transaction, against a named counterparty — or the database refuses the
 * commit (`schema.sql`, "TOKEN CONSERVATION"; owner, 2026-10-07). That is true
 * of a test's own funding too: a suite that credited a wallet from nowhere
 * would be asserting against a state the platform cannot reach (§32 S16).
 *
 * So a test funds a player the way the platform does when no game or order is
 * behind it — out of the platform's own holding, TOKEN_SUPPLY → USER_FLOAT,
 * exactly as a referral reward or an admin credit does. It is a transfer, so
 * the books still close, and `TOKEN_SUPPLY`'s ceiling still applies.
 *
 * Fixtures that stage a balance by writing `wallets` DIRECTLY (the load
 * generator, the live operations harness) post the matching treasury movement
 * instead — see `loadtest/scale.mjs`.
 */
export const TEST_FUNDING = Object.freeze({
  account: 'TOKEN_SUPPLY',
  operation: 'TEST_FUNDING',
  reason: 'Test fixture funding',
});

/**
 * Put tokens in a player's wallet the way the platform does, through the real
 * writer: the pocket and USER_FLOAT move together, so the fixture leaves the
 * books closed and the suite is asserting against a state production can
 * reach. Throws rather than returning a refusal — a fixture that quietly
 * funded nothing makes every assertion after it meaningless.
 */
export async function fundWallet(userId, paise, txId, field = 'depositBalance') {
  const { applyDeltaPaise } = await import('../repositories/wallets.core.js');
  const r = await applyDeltaPaise({
    userId, field, deltaPaise: paise, txId, type: 'CREDIT',
    reason: 'Test fixture funding', counterparty: TEST_FUNDING,
  });
  if (!r.ok) throw new Error(`fundWallet(${userId}, ${paise}) was refused: ${r.refused ?? 'insufficient'}`);
  return r;
}

/**
 * Which guard refused this write — the CONSTRAINT name, not the sentence.
 *
 * A `RAISE … USING CONSTRAINT = '…'` puts the name on the error's `constraint`
 * field and the explanation in its message, so matching the message would pin
 * the prose rather than the rule. Returns `{ constraint, message }`, or throws
 * if the write SUCCEEDED — a guard that let the bad write through must fail
 * the test loudly rather than read as "no error matched".
 */
export async function refusedBy(promise) {
  try {
    await promise;
  } catch (e) {
    return { constraint: e.constraint ?? null, message: e.message };
  }
  throw new Error('the write was NOT refused — it committed');
}

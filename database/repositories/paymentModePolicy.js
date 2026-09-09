// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * repositories/paymentModePolicy.js — which settlement rail is live, and the
 * timers that go with it.
 *
 * The platform runs ONE of two P2P rails at a time:
 *
 *   P2P_UPI   the player pays a merchant UPI and submits a UTR; the merchant
 *             pays a withdrawal into the player's bank. Amounts are a range.
 *   CASH_ATM  the player draws cash at an ATM using a merchant-supplied link;
 *             the merchant deposits cash at a CDM. Amounts are denominations.
 *
 * Neither is deleted when the other is live. The point of the switch is that
 * moving between them costs a button press and no infrastructure work.
 *
 * ── Why a versioned row rather than a feature flag ──────────────────────────
 * `featureFlags.service.js` resolves from an env var and an in-process Map: it
 * does not survive a restart, it names nobody, and it cannot answer "which rail
 * was live when this order was created" — the question every dispute about an
 * in-flight order reduces to. This is the same shape as `deposit_policies` and
 * `merchant_bonus_policies` because it is the same kind of thing: an
 * admin-editable value that governs money and must still be readable months
 * later.
 *
 * ── Why nothing here is cached ──────────────────────────────────────────────
 * A cache on this read is a staleness bug with money on the other side of it:
 * an admin flips the rail, the panel says CASH_ATM, and orders keep opening on
 * the old one until a TTL expires. It is one indexed row against a partial
 * unique index, read once per order creation — next to the transaction that
 * follows it, the read is free. If it ever needs a cache, it needs an
 * invalidation hook first, not a TTL.
 */
import { pgQuery, withTransaction } from '../client.js';

/** The two rails. Import these — never write the strings. */
export const PAYMENT_MODES = Object.freeze({
  P2P_UPI:  'P2P_UPI',
  CASH_ATM: 'CASH_ATM',
});

const KNOWN_MODES = Object.freeze(Object.values(PAYMENT_MODES));

/**
 * The timers a version may set, and the column each one owns.
 *
 * An allowlist, for the same reason `SETTABLE` is one: a switch handler taking
 * a body straight from an admin panel is one typo away from writing a column
 * nobody meant to expose, and `setOrderFields` has already shipped that bug
 * three times in three files.
 */
export const POLICY_TIMERS = Object.freeze({
  assignmentWaitSeconds:   'assignment_wait_seconds',
  processingWindowSeconds: 'processing_window_seconds',
  utrSubmitSeconds:        'utr_submit_seconds',
  disputeWindowSeconds:    'dispute_window_seconds',
  linkExpirySeconds:       'link_expiry_seconds',
  linkMinRemainingSeconds: 'link_min_remaining_seconds',
  // How many orders a merchant may hold at once on THIS rail. One on the cash
  // rail, in either direction, because the notes a merchant is holding are the
  // same notes — two open orders would promise them twice. Not true of the UPI
  // rail, where a merchant moves bank balance and can genuinely run several,
  // which is why it belongs to the policy rather than being one platform-wide
  // number. `merchants.max_concurrent_orders` still overrides it per merchant.
  maxConcurrentOrders:     'max_concurrent_orders',
});

const toPolicy = (r) => (r ? {
  id: Number(r.id),
  _id: `paymentMode:v${r.version}`,
  version: Number(r.version),
  status: r.status,
  activeMode: r.active_mode,
  // INTEGER comes back as a JS number, but every one of these is compared
  // against a clock and Number() here costs nothing and removes the question.
  assignmentWaitSeconds:   Number(r.assignment_wait_seconds),
  processingWindowSeconds: Number(r.processing_window_seconds),
  utrSubmitSeconds:        Number(r.utr_submit_seconds),
  disputeWindowSeconds:    Number(r.dispute_window_seconds),
  linkExpirySeconds:       Number(r.link_expiry_seconds),
  linkMinRemainingSeconds: Number(r.link_min_remaining_seconds),
  maxConcurrentOrders:     Number(r.max_concurrent_orders),
  justification: r.justification,
  changedBy: r.changed_by,
  changedByName: r.changed_by_name,
  createdAt: r.created_at,
  supersededAt: r.superseded_at,
} : null);

/**
 * The policy a new order is created under. Exactly one row, by construction —
 * the partial unique index is what makes that true, and the schema seeds a
 * version 1 so this never returns null on a live database.
 */
export async function getActivePolicy() {
  const { rows } = await pgQuery(
    "SELECT * FROM payment_mode_policies WHERE status = 'ACTIVE'",
    [], 'payment_mode_active',
  );
  return toPolicy(rows[0]);
}

/** The rail alone, for callers that only need to branch. */
export async function getActivePaymentMode() {
  const policy = await getActivePolicy();
  return policy?.activeMode ?? PAYMENT_MODES.P2P_UPI;
}

/**
 * How many orders one merchant may hold at once — the ONE answer.
 *
 * ── Why the cash rail is not configurable here ────────────────────────────
 * `max_concurrent_orders` is a policy column defaulting to 3, and it is carried
 * forward across a rail switch on purpose: a switch that silently resets an
 * admin's tuned numbers is its own bug, and the mutation harness has an entry
 * for it.
 *
 * The consequence was that switching to CASH_ATM kept 3 while the rule this
 * platform runs on is ONE — a merchant at a machine is holding notes, and two
 * orders would promise the same notes twice. The column's comment said 1 and its
 * value said 3, and nothing reconciled them.
 *
 * That is not a preference an operator should be able to get wrong, because it
 * is not a preference: it follows from the cash being physical. So on the cash
 * rail the answer is 1, derived, and the policy column governs the UPI rail
 * where a merchant is moving bank balance and can genuinely run several.
 *
 * The per-merchant override is honoured on the UPI rail and NOT on the cash one,
 * for the same reason: an admin cannot grant a merchant a second pair of hands.
 *
 * Every consumer reads this — the scorer that ranks candidates and the cash-link
 * supply guard. Two places deciding a merchant's capacity would drift, and the
 * direction of the drift is a merchant promised out twice.
 */
export function concurrencyCapFor(policy, merchant = null) {
  if (policy?.activeMode === PAYMENT_MODES.CASH_ATM) return 1;
  return merchant?.maxConcurrentOrders ?? policy?.maxConcurrentOrders ?? 3;
}

/**
 * The rail stamp a NEW order carries.
 *
 * `order_states` has two insert paths — `openOrder` (the lifecycle module,
 * which writes the six columns the state machine needs plus the tamper tag)
 * and `createOrderRecord` (which writes the row and its detail together). Two
 * writers each reading the policy their own way is how the same value comes to
 * be derived twice and drift; this is the one place that answers it.
 *
 * A caller may FORCE the rail — tests build orders on a rail other than the
 * live one — but nobody has to remember to, because the default is a read.
 *
 * ── Take a mode, not a policy ──────────────────────────────────────────────
 * This took a policy OBJECT and read `.activeMode` off it. `createOrderRecord`
 * documents its own parameter as "the rail to stamp", so every caller passed
 * the STRING — and `'CASH_ATM'?.activeMode` is `undefined`, which fell through
 * to the P2P default. The argument was accepted, ignored, and the order came
 * back on the wrong rail with nothing raised: a cash-rail suite that forced the
 * rail this way was in fact testing the UPI rail.
 *
 * So it takes the mode itself, and REFUSES one it does not recognise. A rail
 * that silently becomes a different rail is a merchant asked for a UTR on a
 * payout settled at a machine.
 *
 * A forced rail carries `version: null` unless it matches the live policy —
 * because no published policy said this order should be on it, and a version
 * that points at a policy naming the other rail is a lie in the audit trail.
 */
export async function stampForNewOrder(forcedMode = null) {
  const active = await getActivePolicy();
  const live = active?.activeMode ?? PAYMENT_MODES.P2P_UPI;
  if (forcedMode === null || forcedMode === undefined) {
    return { mode: live, version: active?.version ?? null };
  }
  if (!KNOWN_MODES.includes(forcedMode)) {
    throw new Error(`stampForNewOrder: unknown payment mode '${forcedMode}'`);
  }
  return {
    mode: forcedMode,
    version: forcedMode === live ? (active?.version ?? null) : null,
  };
}

export async function getPolicyHistory({ limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pgQuery(
    `SELECT * FROM payment_mode_policies ORDER BY version DESC LIMIT ${capped}`,
    [], 'payment_mode_history',
  );
  return rows.map(toPolicy);
}

export async function getPolicyVersion(version) {
  const { rows } = await pgQuery(
    'SELECT * FROM payment_mode_policies WHERE version = $1',
    [Number(version)], 'payment_mode_version',
  );
  return toPolicy(rows[0]);
}

/**
 * Publish a new version — the switch, and any timer change.
 *
 * The supersede and the insert are ONE transaction, for the reason
 * `depositPolicy.createPolicyVersion` documents: making the new row active
 * first leaves a window in which two are, and the next order reads whichever
 * the query returns.
 *
 * What actually stops two admins saving at once is NOT the supersede. Under
 * READ COMMITTED the loser re-checks the row it blocked on, finds it already
 * SUPERSEDED, matches nothing and holds no lock — while the winner's new ACTIVE
 * row is invisible to that statement. It is `payment_mode_policies_one_active`
 * (or `version` being UNIQUE) that refuses the second insert, and the loser
 * gets a CONCURRENT_CHANGE it can retry.
 *
 * Timers not named in the patch are CARRIED FORWARD from the version being
 * superseded, not reset to the column defaults. An admin switching the rail is
 * not thereby discarding the windows they tuned last week.
 */
export async function publishPolicyVersion({
  activeMode, timers = {}, justification = '',
  changedBy = null, changedByName = '',
  ...unknown
} = {}) {
  // ── An unrecognised key is REFUSED, not dropped ─────────────────────────
  // The timers live in a nested `timers` object, so the natural mistake is to
  // pass one at the top level — `publishPolicyVersion({ utrSubmitSeconds: 300,
  // justification })`. That used to return ok:true and publish a version with
  // the old value: a write reported as successful that did not happen, which is
  // the exact shape `setOrderFields` refuses and the document model's silent
  // discard of an undeclared path.
  //
  // It cost a debugging round the first time somebody wrote it, and the next
  // person to write it would be an admin route silently failing to change a
  // window an operator had just set.
  const stray = Object.keys(unknown);
  if (stray.length) {
    return {
      ok: false,
      reason: 'UNKNOWN_FIELD',
      message: `Not a field on a policy version: ${stray.join(', ')}.`
        + ` Timers go in \`timers\`: ${Object.keys(POLICY_TIMERS).join(', ')}.`,
    };
  }
  if (activeMode !== undefined && !KNOWN_MODES.includes(activeMode)) {
    return {
      ok: false,
      reason: 'UNKNOWN_MODE',
      message: `Unknown payment mode '${activeMode}'. Known modes: ${KNOWN_MODES.join(', ')}.`,
    };
  }
  if (!String(justification).trim()) {
    return {
      ok: false,
      reason: 'JUSTIFICATION_REQUIRED',
      message: 'A change of settlement rail must say why. It is what a reviewer reads months later.',
    };
  }

  const unknownTimers = Object.keys(timers).filter((k) => !POLICY_TIMERS[k]);
  if (unknownTimers.length) {
    return {
      ok: false,
      reason: 'UNKNOWN_TIMER',
      message: `Not a timer on this policy: ${unknownTimers.join(', ')}.`,
    };
  }
  for (const [key, value] of Object.entries(timers)) {
    if (!Number.isInteger(value) || value <= 0) {
      return {
        ok: false,
        reason: 'TIMER_NOT_POSITIVE',
        message: `${key} must be a positive whole number of seconds (got ${value}). Zero is not "no limit", it is "expire immediately".`,
      };
    }
  }

  try {
    return await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        "SELECT * FROM payment_mode_policies WHERE status = 'ACTIVE'",
      );
      const previous = current[0] ?? null;

      await client.query(
        `UPDATE payment_mode_policies SET status = 'SUPERSEDED', superseded_at = now()
          WHERE status = 'ACTIVE'`,
      );

      // Carried forward from the row being superseded, so a rail switch does
      // not silently reset windows an admin tuned.
      const columns = Object.values(POLICY_TIMERS);
      const values = Object.entries(POLICY_TIMERS).map(([field, column]) => (
        timers[field] !== undefined ? timers[field] : (previous ? Number(previous[column]) : null)
      ));

      const mode = activeMode ?? previous?.active_mode ?? PAYMENT_MODES.P2P_UPI;
      const named = columns.filter((_, i) => values[i] !== null);
      const namedValues = values.filter((v) => v !== null);
      const params = [mode, String(justification).trim(), changedBy, String(changedByName || ''), ...namedValues];
      const placeholders = named.map((_, i) => `$${i + 5}`);

      const { rows } = await client.query(
        `INSERT INTO payment_mode_policies
           (version, status, active_mode, justification, changed_by, changed_by_name${named.length ? ', ' + named.join(', ') : ''})
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM payment_mode_policies),
                 'ACTIVE', $1, $2, $3, $4${placeholders.length ? ', ' + placeholders.join(', ') : ''})
         RETURNING *`,
        params,
      );
      return { ok: true, policy: toPolicy(rows[0]), previous: toPolicy(previous) };
    });
  } catch (err) {
    // The table refused it. Each is an operator error with a specific answer,
    // not a 500: say which rule stopped the save.
    if (err.constraint === 'payment_mode_policies_link_window_usable') {
      return {
        ok: false,
        reason: 'LINK_WINDOW_UNUSABLE',
        message: 'linkMinRemainingSeconds must be less than linkExpirySeconds, or no link is ever assignable.',
      };
    }
    if (err.constraint === 'payment_mode_policies_concurrency_positive') {
      return {
        ok: false,
        reason: 'CONCURRENCY_OUT_OF_RANGE',
        message: 'maxConcurrentOrders must be between 1 and 10. One is the cash rail\'s answer; zero would stop assigning to anybody.',
      };
    }
    if (err.constraint === 'payment_mode_policies_timers_positive') {
      return { ok: false, reason: 'TIMER_NOT_POSITIVE', message: 'Every timer must be a positive number of seconds.' };
    }
    if (err.constraint === 'payment_mode_policies_mode_known') {
      return { ok: false, reason: 'UNKNOWN_MODE', message: `Known modes: ${KNOWN_MODES.join(', ')}.` };
    }
    if (err.constraint === 'payment_mode_policies_justified') {
      return { ok: false, reason: 'JUSTIFICATION_REQUIRED', message: 'A change of settlement rail must say why.' };
    }
    if (err.code === '23505') {
      return { ok: false, reason: 'CONCURRENT_CHANGE', message: 'Another change landed first. Reload and try again.' };
    }
    throw err;
  }
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * shared/httpError.js — what an unexpected failure is allowed to tell a caller.
 *
 * ── The shape this closes ──────────────────────────────────────────────────
 * `res.status(500).json({ success: false, message: err.message })`.
 *
 * Whatever went wrong now speaks directly to whoever asked. From a Postgres
 * driver that is a constraint name, a column list, sometimes a fragment of the
 * statement; from `fs` it is a path; from a fetch it is an internal hostname
 * and port. None of it is anything a caller needs, and four of the sites
 * carrying this pattern were reachable **without authentication at all** — a
 * schema tour available to the open internet by breaking one query.
 *
 * The second half is worse and easier to miss: at those sites the error was
 * sent to the caller and **not logged anywhere**. The one party who could act
 * on the failure never saw it; the one party who should not, did.
 *
 * ── What this deliberately does NOT touch ──────────────────────────────────
 * A refusal that somebody WROTE for a caller to read — "That code is not
 * valid", "A QR code must be uploaded here first", "This UTR was already used"
 * — is the opposite of this problem and must keep its wording. Those carry a
 * `status` (400/403/409) and often a `code`. `callerError()` below is for
 * exactly those, and the two are separate functions so that a handler has to
 * SAY which kind of failure it is holding rather than defaulting into leaking.
 */

/**
 * An unexpected failure. Logged in full, answered with nothing.
 *
 * @param {import('express').Response} res
 * @param {unknown} err     the real error — logged, never sent
 * @param {string}  where   a stable label for the log, e.g. 'GET /v1/wallet/ledger'
 * @param {string}  [message] what the caller is told; keep it useless to an attacker
 */
export function serverError(res, err, where, message = 'Something went wrong. Please try again.') {
  // Logged BEFORE responding: a handler that throws while responding still
  // leaves the operator a record of what actually failed.
  console.error(`[${where}]`, err?.stack || err?.message || err);
  return res.status(500).json({ success: false, message });
}

/**
 * A failure the caller caused, whose message was written for them to read.
 *
 * Takes the status and code from the error when it carries them — the
 * validators in `shared/storedUrl.js` and the payment-reference registry both
 * do — so a handler does not restate them and cannot drift from them.
 */
export function callerError(res, err, fallbackStatus = 400) {
  return res.status(err?.status || fallbackStatus).json({
    success: false,
    ...(err?.code ? { code: err.code } : {}),
    message: err?.message || 'That request could not be accepted.',
  });
}

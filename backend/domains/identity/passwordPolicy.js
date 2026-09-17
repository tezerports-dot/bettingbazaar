// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * passwordPolicy.js — the one rule about what a STAFF password may be.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * There was no rule. `POST /api/admin/sub-admins` took whatever `password` the
 * body carried and hashed it; so did merchant signup, admin-creates-merchant,
 * and the seeded admin. A one-character password was accepted everywhere.
 *
 * On its own that is bad. What makes it the platform's sharpest edge is what it
 * connects to:
 *
 *   • Nothing makes a staff account enrol a second factor. `loginHandler`
 *     challenges accounts that ALREADY enrolled and issues a full session to
 *     everyone else, and no route guard consults `requires2FA()`. So a weak
 *     password is the whole credential.
 *   • A session lasts 24 hours by default.
 *   • A sub-admin reaches 51 admin routes without any permission key being
 *     checked — every player's record and financial history, the revenue
 *     ledger, merchant wallet ledgers — and can write merchant routing caps.
 *
 * So the weakest credential the platform can mint reads the whole player base.
 * Online brute force is bounded (the admin login carries a pace limiter, a
 * subnet limiter and a captcha, and hashing is argon2id) — the realistic path
 * is a reused password found in a breach corpus, or a phished one. A length
 * floor is what makes both of those meaningfully harder.
 *
 * ── Why length and not composition ─────────────────────────────────────────
 * No "must contain a symbol" rule. NIST SP 800-63B advises against composition
 * requirements: they push people toward `Password1!` — predictable to a
 * cracker, annoying to a human — while length is what actually costs an
 * attacker. So: a real minimum length, plus refusals for the handful of shapes
 * that are weak at ANY length.
 *
 * ── The distinction that matters at the call site ──────────────────────────
 * This validates a password being SET. It must never be applied to one being
 * VERIFIED — `loginHandler` and the merchant login both re-hash an
 * already-accepted password to upgrade a legacy bcrypt hash to argon2id, and
 * running a floor there would lock out every existing account whose password
 * predates this file. Those two sites take the password as given, deliberately.
 */

/** Staff hold float, read the player base, and move money. 12 is the floor. */
export const STAFF_PASSWORD_MIN_LENGTH = 12;

/**
 * Shapes that are weak at any length. Deliberately short: a blocklist is not a
 * strength meter, and pretending otherwise invites somebody to grow it into
 * one. It catches the passwords people actually pick when a form lets them.
 */
const OBVIOUS = [
  'password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'administrator',
  'changeme', 'secret', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball',
  'bettingbazaar', 'betting', 'bazaar',
];

class PasswordPolicyError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'WEAK_PASSWORD';
  }
}

/** Every character the same, or a straight run up or down the keyboard/alphabet. */
function isDegenerate(value) {
  if (/^(.)\1+$/.test(value)) return true;
  let ascending = true; let descending = true;
  for (let i = 1; i < value.length; i++) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Validate a password being SET on a staff account.
 *
 * @param {string} password
 * @param {object} [context] values the password must not simply repeat
 * @param {string} [context.mobile]
 * @param {string} [context.username]
 * @param {string} [label] what the refusal calls the account, e.g. 'sub-admin'
 * @returns {string} the password, unchanged, so a caller can inline the call
 * @throws {PasswordPolicyError} status 400, code WEAK_PASSWORD
 */
export function assertStaffPassword(password, context = {}, label = 'account') {
  const value = String(password ?? '');

  if (value.length < STAFF_PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `A ${label} password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters. ` +
      'Length is what makes a password hard to crack — a long phrase you can remember ' +
      'beats a short one with symbols in it.',
    );
  }
  // Trimmed to nothing means the length above was whitespace.
  if (!value.trim()) {
    throw new PasswordPolicyError('A password cannot be only spaces.');
  }
  if (isDegenerate(value)) {
    throw new PasswordPolicyError('That password is one repeated or sequential run of characters.');
  }

  // ── Matched against the alphabetic CORE, not as a substring ─────────────
  // A first draft refused anything CONTAINING an obvious word, and it rejected
  // `a-long-enough-password-123` — a 26-character passphrase — because the word
  // "password" appears inside it. That is the composition-rule mistake this
  // file's header warns against, arriving through the back door: it punishes a
  // long, memorable phrase for a substring while `Xk9!q` would sail through on
  // a shorter floor.
  //
  // So: strip the digits and punctuation somebody sprinkles on, and refuse only
  // when what REMAINS is the obvious word itself, or that word repeated. That
  // still catches `password123`, `Admin-Admin`, `qwertyqwerty12` — the shapes
  // people actually pick — and leaves real passphrases alone.
  const core = value.toLowerCase().replace(/[^a-z]/g, '');
  const isObviousCore = OBVIOUS.some((bad) => {
    if (core === bad) return true;
    // The same word typed two or three times is not two or three secrets.
    return bad.length >= 4 && core.length % bad.length === 0
      && core.length / bad.length <= 4
      && core === bad.repeat(core.length / bad.length);
  });
  if (isObviousCore) {
    throw new PasswordPolicyError('That password is a word attackers try first. Choose something unrelated to this platform.');
  }

  // A password that IS the account's own identifier is public knowledge.
  // Matched against the whole lowercased value, not the alphabetic core: a
  // mobile number is digits, and the core has had them stripped.
  const lowered = value.toLowerCase();
  for (const [name, raw] of Object.entries(context)) {
    const known = String(raw ?? '').trim().toLowerCase();
    if (known.length >= 4 && lowered.includes(known)) {
      throw new PasswordPolicyError(`A password must not contain the account's ${name}.`);
    }
  }

  return value;
}

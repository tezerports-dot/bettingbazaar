// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/referralCapture.ts — remember who sent this visitor.
 *
 * A referral link lands on the site as `?ref=CODE` (or `#/...?ref=CODE`), but
 * the visitor does not sign up in that first second — they look around, read
 * the rules, watch a round or two, and only then open the bot. If the code
 * lived only in the URL it would be gone by then, and the person who did the
 * work of inviting them would earn nothing.
 *
 * So the code is captured once at boot and held until it is used. It is
 * attribution data, not a credential: it grants nothing on its own, and the
 * server decides on its own terms whether it names a real referrer and whether
 * that referrer is allowed to earn — see domains/referral/referral.service.js.
 *
 * ── Why the stored value expires ────────────────────────────────────────────
 * Without a lifetime, a code picked up in March would still be attached to a
 * signup in November, crediting a referrer who had nothing to do with it. Ninety
 * days is the ordinary affiliate-tracking window and is long enough to cover any
 * real "thought about it for a while" gap.
 */
const KEY = 'bb_referral_code';
const STAMP = 'bb_referral_at';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Codes are short, alphanumeric and case-insensitive; anything else is noise. */
function clean(raw: string | null): string {
  if (!raw) return '';
  const v = String(raw).trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(v) ? v : '';
}

/**
 * Read `ref` from wherever it landed and store it.
 *
 * Handles both `?ref=` on the real query string and `#/path?ref=` inside the
 * hash, because a shared link may carry either depending on who built it.
 * Called once from the app entry point.
 */
export function captureReferralCode(href: string = window.location.href): string {
  let found = '';
  try {
    const url = new URL(href);
    found = clean(url.searchParams.get('ref'));
    if (!found && url.hash.includes('?')) {
      found = clean(new URLSearchParams(url.hash.slice(url.hash.indexOf('?'))).get('ref'));
    }
  } catch { /* a malformed URL simply yields no code */ }

  if (!found) return storedReferralCode();

  // First code wins. Someone who arrives on A's link and later clicks B's has
  // already been introduced by A, and letting the last click overwrite it is
  // what makes affiliate stealing worth doing.
  const existing = storedReferralCode();
  if (existing) return existing;

  try {
    localStorage.setItem(KEY, found);
    localStorage.setItem(STAMP, String(Date.now()));
  } catch { /* private mode: attribution is best-effort, never a blocker */ }
  return found;
}

/** The held code, or '' if there is none or it has aged out. */
export function storedReferralCode(): string {
  try {
    const code = clean(localStorage.getItem(KEY));
    if (!code) return '';
    const at = Number(localStorage.getItem(STAMP) || 0);
    if (!at || Date.now() - at > MAX_AGE_MS) {
      clearReferralCode();
      return '';
    }
    return code;
  } catch { return ''; }
}

export function clearReferralCode(): void {
  try { localStorage.removeItem(KEY); localStorage.removeItem(STAMP); } catch { /* ignore */ }
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * shared/storedUrl.js — one owner for "is this URL safe to store and render?"
 *
 * ── The shape this exists to close ─────────────────────────────────────────
 * A URL arrives in a request body, is written to a row, and is later rendered
 * to somebody else. Five fields did that with no validation at all, and two of
 * them are PAYMENT INSTRUCTIONS shown to a player:
 *
 *   `cash_links.payment_link`    the ATM intent — where the player pays
 *
 * An upload flow exists for the QR (`POST /api/merchant/qr/upload-url`), but
 * nothing bound the stored value to it: the route handed back a presigned URL
 * and the merchant then sent whatever string they liked to
 * `PUT /api/merchant/profile`. The upload was a suggestion.
 *
 * What that costs, in order of how much it matters:
 *
 * 1. **It leaks the player to a third party.** Every player assigned to that
 *    merchant loads an image from a host of the merchant's choosing, which
 *    learns their IP, their user agent, and the exact moment they were shown a
 *    payment screen. §24 is about not publishing identities across the P2P
 *    boundary; an off-platform image in the payment screen publishes the
 *    player's, to somebody the platform never chose.
 * 2. **A payment instruction hosted elsewhere can change after anyone looks at
 *    it.** Approving a QR you do not host approves a URL, not an image — the
 *    bytes behind it are the merchant's to swap the moment review ends. There
 *    is no honest way to review externally-hosted payment instructions.
 * 3. It removes the byte check. `verifyUploadedObject` reads the first 8 KB and
 *    matches magic bytes; a URL that never went through the upload flow was
 *    never any file this platform saw.
 *
 * ── Why validation happens on WRITE and not on read ────────────────────────
 * Rows written before this existed keep rendering. Refusing them at read time
 * would blank a live merchant's payment screen to fix a problem they did not
 * cause; refusing them at write time means the next edit corrects it and
 * nothing breaks in between. The gate is the door, not the window.
 */

/**
 * The CDN origin this platform serves its own assets from.
 *
 * Read at call time rather than at import: `cdn.service.js` does the same, and
 * a module-level snapshot would freeze whatever the environment held when the
 * first import ran — which in tests is often nothing.
 */
function cdnOrigin() {
  const raw = process.env.CDN_URL;
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

class StoredUrlError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'UNSAFE_URL';
  }
}

/**
 * An asset this platform hosts, and nothing else.
 *
 * Compared by parsed ORIGIN, never by `startsWith`. A prefix test on
 * `https://cdn.example.com` accepts `https://cdn.example.com.evil.test/x` —
 * the string starts with it, and the host is somebody else's.
 *
 * @param {string} value
 * @param {string} label  what to call it in the refusal the caller sees
 * @returns {string} the URL, trimmed
 */
export function assertCdnAssetUrl(value, label = 'image') {
  const url = String(value ?? '').trim();
  if (!url) throw new StoredUrlError(`A ${label} URL is required.`);

  const origin = cdnOrigin();
  if (!origin) {
    // Fails CLOSED. With no CDN configured there is no such thing as "our own
    // asset", so there is nothing this can honestly accept.
    throw new StoredUrlError('Image hosting is not configured, so an image cannot be saved right now.');
  }

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new StoredUrlError(`That ${label} is not a valid URL.`); }

  if (parsed.origin !== origin) {
    throw new StoredUrlError(
      `A ${label} must be uploaded here first — a link to another site cannot be used.`,
    );
  }
  // Credentials in a URL are never legitimate for an asset and are a known way
  // to make a hostile link read as a familiar one in a status bar.
  if (parsed.username || parsed.password) {
    throw new StoredUrlError(`That ${label} URL is not accepted.`);
  }
  return url;
}

/**
 * A UPI payment intent, which is what an ATM hands the merchant.
 *
 * Deliberately narrow: this string is put in front of a player as *where to
 * pay*, so the only thing it may be is the payment scheme. `upi:` carries the
 * payee, which the player's own banking app will show them — the platform
 * cannot hide a payee from a payer (§24), and does not try to. What it can do
 * is refuse to hand a player anything that is not a payment at all.
 *
 * @param {string} value
 * @returns {string} the link, trimmed
 */
export function assertPaymentIntent(value) {
  const link = String(value ?? '').trim();
  if (!link) throw new StoredUrlError('A payment link is required.');
  // Length before parse: a URL object will happily hold megabytes, and this one
  // is delivered over a socket to every waiting client.
  if (link.length > 2048) throw new StoredUrlError('That payment link is too long to be a UPI intent.');

  let parsed;
  try { parsed = new URL(link); }
  catch { throw new StoredUrlError('That is not a valid payment link.'); }

  if (parsed.protocol !== 'upi:') {
    throw new StoredUrlError('That is not a UPI payment link — copy the link the machine produced.');
  }
  // A `upi:` intent that names no payee is not one a player can pay.
  const params = new URLSearchParams(parsed.search || (parsed.pathname.includes('?') ? parsed.pathname.split('?')[1] : ''));
  if (!params.get('pa')) {
    throw new StoredUrlError('That payment link names no payee — copy the whole link the machine produced.');
  }
  return link;
}

/**
 * An operator-set link out to another site (a merchant's own panel host).
 *
 * `https:` only. Not because http is rare, but because this is stored by one
 * party and followed by another, which is the condition under which a
 * downgrade is somebody else's problem.
 */
export function assertExternalHttpsUrl(value, label = 'URL') {
  const url = String(value ?? '').trim();
  if (!url) throw new StoredUrlError(`A ${label} is required.`);
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new StoredUrlError(`That ${label} is not a valid URL.`); }
  if (parsed.protocol !== 'https:') throw new StoredUrlError(`A ${label} must start with https://`);
  if (parsed.username || parsed.password) throw new StoredUrlError(`That ${label} is not accepted.`);
  return url;
}

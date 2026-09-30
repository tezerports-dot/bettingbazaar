// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The security headers, with a `frame-src` that follows the provider table.
 *
 * ── Why this is a module and not `app.use(helmet(...))` ───────────────────
 * One directive's value is data an admin edits — which origins a game may be
 * framed from (see domains/casino/providerFrameSources.js). Helmet builds its
 * middleware ONCE from the options it is given, so a value that changes needs
 * the middleware rebuilt; a function cannot be passed in place of a directive's
 * list, because helmet iterates it.
 *
 * So: one stable middleware is mounted, and it delegates to a helmet instance
 * that is rebuilt only when the SET OF ORIGINS ACTUALLY CHANGES. Rebuilding per
 * request would re-parse and re-validate every directive on every response for
 * a value that changes a few times a year.
 *
 * ── The comparison is why this is cheap ───────────────────────────────────
 * `providerFrameSources()` returns a fresh array each call, so comparing by
 * reference would rebuild on every request and comparing by `length` would miss
 * a provider swapped for another. The joined string is compared, which is exact
 * and is the same string helmet would build anyway.
 */
import helmet from 'helmet';
import { helmetOptionsFraming } from '../config/security.config.js';
import { providerFrameSources } from '../domains/casino/providerFrameSources.js';

let built = null;
let builtFrom = null;

/** The helmet instance for the origins in force right now. */
function current() {
  const sources = providerFrameSources();
  const key = sources.join(' ');
  if (built && builtFrom === key) return built;
  builtFrom = key;
  built = helmet(helmetOptionsFraming(sources));
  return built;
}

/**
 * Mounted once, in place of `helmet(HELMET_OPTIONS)`.
 *
 * Delegates rather than being replaced, because Express has no way to swap a
 * mounted middleware and rebuilding the stack on a config change is how a
 * server ends up serving two different policies to two in-flight requests.
 */
export function securityHeaders(req, res, next) {
  return current()(req, res, next);
}

/** Test seam: forget the built instance so the next call rebuilds. */
export function __resetSecurityHeadersCache() {
  built = null;
  builtFrom = null;
}

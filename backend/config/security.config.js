// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * config/security.config.js — Central Security Configuration (plan item 19)
 * + explicit security-header decisions (plan item 21). 2026-07-13.
 *
 * ONE file holds security policy AS DATA: CSP directives, CORS shape, and
 * rate-limit tiers. server.js and middleware/security.js consume these instead
 * of defining values inline. This is a refactor of working code — every value
 * below is IDENTICAL to what shipped scattered before; changing policy now
 * means editing THIS file only.
 *
 * Item 21 header audit (helmet v7/v8 defaults we explicitly RELY on — set by
 * `helmet()` without extra config; listed so the decision is recorded, not
 * implicit):
 *   X-Content-Type-Options: nosniff        — stop MIME sniffing
 *   X-Frame-Options: SAMEORIGIN            — no cross-site framing of panels
 *   Referrer-Policy: no-referrer           — don't leak bet/wallet URLs
 *   Strict-Transport-Security (prod https) — pin https once seen
 *   X-DNS-Prefetch-Control: off, X-Download-Options: noopen,
 *   Cross-Origin-Opener-Policy: same-origin, X-XSS-Protection: 0 (modern)
 * Non-default choices we make explicitly: CSP directives below and
 * crossOriginEmbedderPolicy=false (provider iframes/CDN images break under
 * COEP require-corp — deliberate).
 */

// ── Content-Security-Policy — the only non-default helmet section ────────────
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"],
  styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc:     ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
  objectSrc:  ["'none'"], manifestSrc: ["'self'"],
  // `frameSrc` is NOT here. It is the one directive whose value is data in the
  // database — see `helmetOptionsFraming` below and providerFrameSources.js.
};

export const HELMET_OPTIONS = {
  contentSecurityPolicy: { directives: CSP_DIRECTIVES },
  crossOriginEmbedderPolicy: false, // provider game iframes + CDN images
};

/**
 * The helmet options, for a given set of frameable origins.
 *
 * ── Why `frame-src` cannot be a literal in this file ──────────────────────
 * WHO WE MAY FRAME. `frameAncestors` — who may frame US — was here from
 * helmet's defaults and this was not, and they are opposite questions. With no
 * `frame-src`, CSP falls back to `default-src 'self'`, so every provider game
 * the platform can launch was blocked by the browser: CasinoPage, CrashPage and
 * SportsPage each rendered their chrome around a blank frame, with the refusal
 * only in the browser console.
 *
 * The answer lives in `game_providers`, which an admin edits. A literal list
 * here would be a second owner of "who are our suppliers" (§2, §5) — an
 * operator would add a provider, the game would still not load, and nothing
 * would say why.
 *
 * ── Why a BUILDER rather than a function in the directive ─────────────────
 * Helmet's directive values are ITERABLES. It accepts a function as an ELEMENT
 * of one — `(req, res) => 'https://x'`, a single source — but not in place of
 * the list, and passing one throws `directiveValue is not iterable` at boot.
 * So the middleware is rebuilt when the set of origins changes, which uses
 * helmet exactly as designed and keeps this file pure data plus one pure
 * function. `cspMiddleware.js` owns the rebuilding.
 */
export function helmetOptionsFraming(frameSrc = []) {
  return {
    ...HELMET_OPTIONS,
    contentSecurityPolicy: {
      directives: { ...CSP_DIRECTIVES, frameSrc: ["'self'", ...frameSrc] },
    },
  };
}

// ── CORS ──────────────────────────────────────────────────────────────────────
// The origin check function stays in server.js (it closes over env parsing);
// the static shape lives here.
export const CORS_SHAPE = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // ── Every header a panel is allowed to send, and why the list matters ────
  // A browser will not send a header that is not named here. It asks first, in
  // a preflight, and if the answer omits the header it CANCELS the request —
  // the call never reaches the server, so there is no log line, no status code
  // and nothing for a route test to see.
  //
  // `Idempotency-Key` was missing, and three routes REQUIRE it: `POST
  // /bet/place`, and the admin top-up and deduction. So from any browser on a
  // different origin from the API — which is the deployment model (§15: three
  // frontends, one backend, each deployed on its own) — **placing a bet and
  // funding a merchant were both blocked before they left the page**, with the
  // panel seeing a network failure rather than a refusal it could explain.
  //
  // Nothing could see it below a browser: curl sends what it is told, so the
  // route tests, the panel tests and a hand-made request all passed. It was
  // found by pressing the button (§28, §32 S26).
  //
  // A header a panel sends belongs in this list in the SAME change that starts
  // sending it.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key'],
  optionsSuccessStatus: 200,
};

/**
 * TEMPORARY, AND OFF UNLESS ASKED FOR — see CLAUDE.md §34.
 *
 * A whole-stack browser pass presses ~1,300 controls across 67 screens. The
 * global backstop is 1,000 requests per 15 minutes, so the pass spends most of
 * its wall-clock WAITING for the window to roll over rather than pressing
 * anything — measured in hours, not minutes, for one panel.
 *
 * `BB_RATE_LIMIT_RELAX` multiplies every tier's `max`. It is a development
 * convenience for exactly that, and three things keep it from being a way to
 * ship a weaker platform:
 *
 *   1. It defaults to 1, so nothing changes for anyone who does not set it.
 *   2. It is REFUSED IN PRODUCTION — set it with `NODE_ENV=production` and the
 *      server does not boot. A knob that silently weakens a live deployment is
 *      exactly the thing §19 says must not be possible, so this one cannot be
 *      turned in a place where it would matter.
 *   3. It says so at boot, in one line nobody can miss, because §33.7's
 *      bootstrap exemption already taught this codebase that an exemption
 *      nobody can see is a hole nobody removes.
 *
 * WINDOWS ARE UNTOUCHED. Only the counts move — the shape of every limiter,
 * and therefore what each one is FOR, is unchanged.
 */
const RELAX = (() => {
  const raw = process.env.BB_RATE_LIMIT_RELAX;
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`BB_RATE_LIMIT_RELAX must be a number >= 1; got ${JSON.stringify(raw)}`);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'BB_RATE_LIMIT_RELAX is a development convenience and is refused in production. '
      + 'Unset it, or do not run this build as production.',
    );
  }
  if (n !== 1) {
    console.warn(
      `\n!! RATE LIMITS RELAXED ${n}x — BB_RATE_LIMIT_RELAX is set. This is a development\n`
      + '   convenience for browser passes (CLAUDE.md §34). Windows are unchanged; only the\n'
      + '   counts are multiplied. This server is NOT enforcing production limits.\n',
    );
  }
  return n;
})();

/** Apply the relaxation to one tier. Windows never move; only `max`. */
const tier = (windowMs, max) => ({ windowMs, max: max * RELAX });

// ── Rate-limit tiers (values unchanged from middleware/security.js + server.js)
export const RATE_LIMIT_TIERS = {
  // Global backstop on /api/* (server.js)
  global: tier(15 * 60 * 1000, 1000),
  // ── Login tiers ───────────────────────────────────────────────────────────
  // IMPORTANT: every login limiter sets `skipSuccessfulRequests: true`, so
  // these count FAILED attempts only. "4 per 30 minutes" does not stop someone
  // logging in five times a day — it stops the fifth WRONG password. Counting
  // successes would lock out the legitimate user who switches devices, while
  // doing nothing extra against a brute-forcer (who is only ever failing).
  //
  // Player login — 4 failures / 30 min (2026-07-28, owner-set).
  auth: tier(30 * 60 * 1000, 4),
  // Admin and sub-admin login — 4 failures / hour. Privileged accounts move
  // money and, per §F, are the highest-value credential on the platform.
  adminAuth: tier(60 * 60 * 1000, 4),
  // Merchant login — 4 failures / hour. Same tier as admin: a merchant account
  // settles real INR and USDT, so it is not a player-grade credential.
  merchantAuth: tier(60 * 60 * 1000, 4),
  // ── PACING, not lockout (owner directive 2026-09-08) ─────────────────────
  // One credential submission per 10 seconds, per actor. This is a DIFFERENT
  // control from the failure budgets below and sits alongside them, because the
  // two answer different questions:
  //
  //   the budgets ask "has this account been guessed at too many times today?"
  //   and lock it; they count FAILURES only, so a correct password resets
  //   nothing and a legitimate user is never locked out for signing in a lot.
  //
  //   this one asks "how fast are attempts arriving?" and simply spaces them.
  //   It counts EVERY attempt, success included — that is the point of a pace —
  //   and it is what makes an automated guesser slow rather than merely capped.
  //
  // A six-digit TOTP is a 10^6 space. At one attempt per 10 seconds a full
  // sweep takes over three months, and each code is only valid for 30 seconds
  // anyway, so the pace alone makes the guess uneconomic before the budget is
  // even consulted.
  loginPace: tier(10 * 1000, 1),
  // ── SIGNUP is not a credential attempt, and must not be paced like one ────
  // A registration submits no secret. Nobody learns anything by sending the
  // form, so there is nothing to guess and nothing to slow down — what has to
  // be bounded is how many ACCOUNTS one address can create, which is a
  // completely different quantity.
  //
  // Measured, before this tier existed: with `loginPace` on /register, a person
  // who mistyped their confirm-password was answered "try again in 10 seconds",
  // and because that bucket is shared with every credential door, their typo
  // also paced the LOGIN of everyone behind the same address. On shared wifi or
  // in a cyber café — ordinary here — one person filling in a form throttles the
  // room. §32 S13, exactly: a refusal that costs the user their next attempt.
  //
  // So this limiter counts SUCCESSES (`skipFailedRequests: true`): correct the
  // form as many times as you like, but ten accounts per address per hour is
  // the ceiling. The real anti-automation control on this route is the captcha,
  // which prices the attempt itself; this bounds the damage if it is beaten.
  signup: tier(60 * 60 * 1000, 10),
  // Second-factor submission, once the password is already correct. Separate
  // and tighter than the password tier: at this point an attacker is guessing
  // a 6-digit code, where 10 tries is 1-in-100,000 rather than 1-in-a-million.
  twoFactor: tier(15 * 60 * 1000, 5),
  // Bet placement bursts
  bet: tier(1 * 60 * 1000, 30),
  // Withdrawal creation
  withdrawal: tier(60 * 60 * 1000, 5),
  // Account recovery / Aadhaar lookup. These endpoints take a national ID and
  // are the one place the platform can be asked "does THIS person have an
  // account here?" — on a gambling site that answer is sensitive on its own,
  // independently of any balance. Tight, and keyed on IP: keying on a field
  // from the request body (the mobile number) let a caller reset their own
  // budget at will, which is no limit at all.
  // ── The payment rails' own routes ────────────────────────────────────────
  // Each of these was added with the feature and shipped WITHOUT a limit. They
  // are not login endpoints, so the auth tiers never covered them, and the
  // global /api/* backstop is 1000 per 15 minutes — which is no limit at all
  // for a route that calls an external API or writes to a queue.
  //
  // Creating a USDT purchase HOLDS A PRICE at the rate live at that moment and
  // puts a merchant's tokens on the hook for the length of the window.
  // Unlimited creation is a way to accumulate options on the exchange rate.
  //
  // It said "makes an outbound request to BTCPay". No code in this repository
  // calls BTCPay or any other processor, and none ever will: on this rail the
  // counterparty is a person (`CLAUDE.md` §25). A comment describing an
  // abandoned plan is the §1 shape, and this one mattered — reading it as
  // "protects somebody else's server" is how a budget of five got written for
  // a number that is actually a player's own hour.
  //
  // Five per hour is deliberately tight because each one prices a purchase.
  // It is survivable ONLY because the limiter counts orders that were actually
  // created: `railLimiter(..., { bounds: 'effects' })` in middleware/security.js
  // skips refusals, so a size that is not a denomination, a missing chain, or a
  // `USDT_RATE_UNSET` outage costs the player nothing. Raise this number if
  // that ever stops being true.
  usdtDeposit: tier(60 * 60 * 1000, 5),
  // A retry creates a NEW order, and on a sell it locks tokens in escrow. The
  // database refuses a second retry of the same order, so this bounds the rate
  // across DIFFERENT orders.
  orderRetry: tier(60 * 60 * 1000, 10),
  // The grace claim extends an order's own deadline. It is once per order by
  // construction (`utr_grace_at IS NULL`), so this bounds how fast a caller can
  // sweep across orders looking for one that has not claimed it.
  utrGrace: tier(60 * 60 * 1000, 30),
  // A merchant supplying cash links. One LIVE link per merchant is enforced by
  // a unique index; this stops a loop churning supply and demand broadcasts.
  cashLinkSupply: tier(60 * 60 * 1000, 60),
  // A CDM receipt carries an uploaded image reference and is read only by an
  // admin. One per order, so this bounds the sweep.
  cdmReceipt: tier(60 * 60 * 1000, 30),
  // General API tier used by security.js's apiLimiter
  api: tier(1 * 60 * 1000, 100),
};

// ── Global-limiter exemption for phantom (ghost) bet placement ──────────────
// Phantom managers fire many equalizer bets in quick succession to keep the
// display pool balanced, so their placements must NOT be throttled by the
// global /api/* backstop. The POST /api/bet/phantom route is itself gated
// (authenticate + phantomAccess → 403 for everyone else) and loadShed still
// bounds total in-flight work, so exempting it removes no real DoS protection.
export const PHANTOM_BET_PATH = '/api/bet/phantom';
// Skip predicate for the global limiter. Matches on the untouched originalUrl
// (immune to app.use() mount-path stripping), drops any query string, and
// normalises a trailing slash so /api/bet/phantom/ is treated identically.
export const isPhantomBetPlacement = (req) =>
  req.method === 'POST' &&
  String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '') === PHANTOM_BET_PATH;

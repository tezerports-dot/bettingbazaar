// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/configuration/systemConfigPayload.js — the one system-config payload.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The same object was assembled twice: once in `startup/socketHandlers.js` to
 * push over Socket.IO on connect, once in `GET /api/v1/system/config` to answer
 * over HTTP. Copies drift, and these already had:
 *
 *   only the socket sent  webUrl, androidUrl, iosUrl
 *   only the HTTP route sent  kycRequired, registrationEnabled
 *
 * So the answer to "what is this platform configured to do" depended on which
 * transport a client happened to ask over. §1 — one owner per value. This is
 * the owner; both callers now derive from it.
 *
 * ── `??`, never `||` ────────────────────────────────────────────────────────
 * The HTTP copy wrote `config?.minDeposit || 100` for every numeric limit. `||`
 * treats a legitimate **0** as absent, so an operator who set a limit to zero —
 * "no minimum" — was silently served the default instead, and the panel
 * enforced a floor the admin had explicitly removed. The socket copy used `??`
 * and did not have this bug, which is precisely the kind of divergence two
 * copies produce. It is the same defect the bet-funding mutation M23 exists to
 * catch, in a different file.
 *
 * Every fallback below matches the config spec's declared default exactly. A
 * server-side fallback that differs from the declared default is a second,
 * invisible configuration: the client is told one number while the engine uses
 * another.
 */

/** The historical five tabs — the schema default for an unset footer. */
const DEFAULT_FOOTER_PAGES = Object.freeze(['home', 'results', 'winners', 'promo', 'profile']);

/**
 * Build the payload every client receives, over any transport.
 *
 * @param {object|null} cfg the SystemConfig row, or null when it cannot be read
 * @returns {object} the full field set — never a partial one
 */
// The INR peg comes from the one place that owns it.
import { USDT_CHAINS, USDT_CHAIN_SPEC } from '../merchant/merchantCurrency.js';
import { tokensPerUsdt } from './tokenRates.js';
import { INR_TOKEN_RATE } from './tokenRates.js';
// The legal buy amounts come from the module the risk gate validates against,
// never from a list written out again here. Two lists drift, and the drift is
// silent until a player is refused an amount the screen offered them.
import {
  BUY_DENOMINATIONS_PAISE, MAX_CASH_BUY_PAISE, USDT_BUY_DENOMINATIONS_PAISE,
} from '../merchant/denominations.js';

export function systemConfigPayload(cfg, rail = null) {
  return {
    // ── The settlement rail, and the amounts it allows ────────────────────
    // The player app must not decide either of these. It ships as an APK
    // containing the whole bundle, so a picker built from a client-side list
    // is a list an attacker can edit — and a list that drifts from the server's
    // is a player being offered an amount the gate will refuse.
    //
    // So the SERVER says what rail is live and which amounts are legal, from
    // the same module `assessFundingOrder` validates against. The picker
    // renders what it is told; it does not know the numbers.
    //
    // `null` when the rail cannot be read, which a client must render as "not
    // available" rather than falling back to a guess.
    paymentMode:         rail?.activeMode ?? null,
    buyDenominations:    BUY_DENOMINATIONS_PAISE.map((p) => p / 100),
    // The CASH rail's ceiling, and only the cash rail's. It was published as
    // `maxInrBuy` and the panel hid the buy button above it on EVERY rail.
    maxCashBuy:          MAX_CASH_BUY_PAISE / 100,
    // The USDT rail's three sizes — in TOKENS, which is what a player buys —
    // and the rate that turns each into the USDT they send. From the SERVER,
    // because all of it is money rules: a panel with its own copy would offer a
    // size the gate refuses or quote a price the order will not honour.
    //
    // `usdtTokensPerUnit` is null when the admin has not set a rate. The panel
    // must then offer nothing rather than showing sizes it cannot price.
    usdtBuyDenominations: USDT_BUY_DENOMINATIONS_PAISE.map((p) => p / 100),
    usdtTokensPerUnit:    tokensPerUsdt(cfg),
    usdtChains:           USDT_CHAINS.map((chain) => ({
      chain, label: USDT_CHAIN_SPEC[chain].label,
    })),

    // Bet limits live in the betLimits subdoc, not on config.value.
    minBet:              cfg?.betLimits?.thirtyMin?.min ?? 10,
    maxBet:              cfg?.betLimits?.thirtyMin?.max ?? 100000,
    maxFullDayBet:       cfg?.betLimits?.fullDay?.max   ?? 500000,

    minDeposit:          cfg?.minDeposit    ?? 100,
    maxDeposit:          cfg?.maxDeposit    ?? 50000,
    minWithdrawal:       cfg?.minWithdrawal ?? 500,
    maxWithdrawal:       cfg?.maxWithdrawal ?? 50000,

    // The INR peg. Not admin-owned, so it is a constant rather than a
    // fallback — and it comes from tokenRates.js, which is the one place that
    // says what a token is worth. It was a bare literal here and in two user
    // routes, with nothing naming the rule or explaining why it cannot move.
    tokenBuyRate:        INR_TOKEN_RATE,
    tokenSellRate:       INR_TOKEN_RATE,

    // Admin-owned (Business Config Audit 2026-07-11) — was once hardcoded 2.
    payoutMultiplier:    cfg?.payoutMultiplier ?? 2,

    maintenanceMode:     cfg?.maintenanceMode    ?? false,
    maintenanceMessage:  cfg?.maintenanceMessage ?? '',

    // Footer navigation (2026-07-13). An empty list means "unset", not "no
    // tabs" — a panel with no navigation is not a state an admin can intend.
    footerPages:         cfg?.footerPages?.length ? cfg.footerPages : [...DEFAULT_FOOTER_PAGES],

    minVersion:          cfg?.minVersion    ?? '1.0.0',
    latestVersion:       cfg?.latestVersion ?? '1.0.0',

    // Native-shell download targets. Only the socket used to carry these.
    webUrl:              cfg?.webUrl     ?? '',
    androidUrl:          cfg?.androidUrl ?? '',
    iosUrl:              cfg?.iosUrl     ?? '',

    // Signup gating. Only the HTTP route used to carry these. `!== false` keeps
    // an unset flag meaning "on", which is what both copies already did.
    kycRequired:         cfg?.kycRequired         !== false,
    registrationEnabled: cfg?.registrationEnabled !== false,
  };
}

/**
 * The payload when the config row cannot be read at all.
 *
 * Deliberately the same builder with no row, rather than a hand-written subset:
 * the socket's old catch block emitted seven fields, so a client that connected
 * during a database blip was told the platform had no deposit limits and no
 * footer. Every field is present here, every value is its declared default.
 */
export function systemConfigFallback() {
  return systemConfigPayload(null);
}

export default systemConfigPayload;

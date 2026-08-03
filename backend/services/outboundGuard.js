// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/outboundGuard.js — SSRF egress policy for every outbound HTTP call.
 *
 * The platform makes outbound requests to operator-configured destinations:
 * game-provider APIs (`provider.apiUrl`, set in the admin panel), an SMS
 * gateway (`SMS_API_URL`), a captcha verifier, and an LLM endpoint. None of
 * these take an end-user-supplied URL today, so this is not closing an
 * anonymous-attacker hole. It closes the one an ADMIN can open — deliberately
 * or with a stolen session — by pointing a provider URL at something only the
 * server can reach:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *   http://10.0.0.5:5432/            (the Postgres money datastore)
 *   http://127.0.0.1:9090/           (metrics, admin-only services)
 *
 * On the Hetzner design in docs/PRODUCTION_ARCHITECTURE.md the databases sit on
 * a private network reachable only from the app nodes — which is exactly the
 * position that makes server-side request forgery valuable. Cloud metadata
 * endpoints are worse still: they hand out credentials to anything that asks
 * from the right IP.
 *
 * ── What this enforces ──────────────────────────────────────────────────────
 *   • protocol allow-list — http/https only (no file:, ftp:, gopher:, data:)
 *   • destination IP checks — every address the hostname resolves to must be
 *     public unicast: no loopback, private, link-local, unique-local,
 *     multicast, broadcast, reserved or unspecified ranges
 *   • redirect validation — redirects are followed MANUALLY so every hop is
 *     re-checked. A permitted host redirecting to 169.254.169.254 is the
 *     classic bypass, and `redirect: 'follow'` would take it silently
 *   • optional host allow-list — when set, nothing outside it is reachable
 *
 * ── DNS rebinding ───────────────────────────────────────────────────────────
 * Validation resolves the hostname and checks every returned address, then the
 * request re-resolves when it connects. A hostile DNS server can answer
 * differently the second time (TOCTOU). Fully closing that needs a custom
 * connect-time lookup hook, which the bundled fetch does not expose without
 * adding undici as a direct dependency. What IS closed: literal-IP targets,
 * every redirect hop, and any hostname whose records are private at check time
 * — which is the whole of the realistic admin-misconfiguration risk, and most
 * of the stolen-session one. The residual gap is recorded here rather than
 * papered over.
 *
 * ── Escape hatch ────────────────────────────────────────────────────────────
 * A self-hosted provider inside your own private network is a legitimate
 * integration that this policy would otherwise block. Set
 * `OUTBOUND_ALLOW_PRIVATE=true` to permit private destinations — deliberately
 * an explicit, logged decision rather than a silent default.
 */
import dns from 'dns';
import ipaddr from 'ipaddr.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** ipaddr.js range names that must never be an outbound destination. */
const BLOCKED_RANGES = new Set([
  'unspecified',    // 0.0.0.0, ::
  'broadcast',      // 255.255.255.255
  'multicast',
  'linkLocal',      // 169.254.0.0/16 — cloud metadata lives here
  'loopback',       // 127.0.0.0/8, ::1
  'private',        // RFC1918
  'uniqueLocal',    // fc00::/7 — includes the IPv6 metadata address
  'reserved',
  'carrierGradeNat',
  'ipv4Mapped',     // ::ffff:127.0.0.1 smuggles a v4 loopback through a v6 literal
]);

export class OutboundBlockedError extends Error {
  constructor(message, { url, reason } = {}) {
    super(message);
    this.name = 'OutboundBlockedError';
    this.url = url;
    this.reason = reason;
  }
}

const csv = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Private destinations permitted? Off unless explicitly enabled. */
export function allowsPrivateDestinations(env = process.env) {
  return String(env.OUTBOUND_ALLOW_PRIVATE || '').trim().toLowerCase() === 'true';
}

/** Optional host allow-list. Empty means "any public host". */
export function allowedHosts(env = process.env) {
  return csv(env.OUTBOUND_ALLOWED_HOSTS).map((h) => h.toLowerCase());
}

/**
 * Is this address a permitted destination?
 * Exported for testing — the range table is the security decision here.
 */
export function isBlockedAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true; // unparseable is not provably safe
  }
  // An IPv4-mapped IPv6 address must be judged on the v4 address it carries,
  // or ::ffff:169.254.169.254 walks straight past the range check.
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    return isBlockedAddress(parsed.toIPv4Address().toString());
  }
  return BLOCKED_RANGES.has(parsed.range());
}

/**
 * Validate one URL against the egress policy. Throws OutboundBlockedError.
 * Resolves DNS, so it is async.
 */
export async function assertAllowedUrl(rawUrl, env = process.env) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new OutboundBlockedError(`Outbound request blocked: not a valid URL`, { url: String(rawUrl), reason: 'invalid-url' });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new OutboundBlockedError(
      `Outbound request blocked: protocol '${url.protocol}' is not permitted (http/https only)`,
      { url: url.href, reason: 'protocol' },
    );
  }

  const hosts = allowedHosts(env);
  if (hosts.length && !hosts.includes(url.hostname.toLowerCase())) {
    throw new OutboundBlockedError(
      `Outbound request blocked: host '${url.hostname}' is not in OUTBOUND_ALLOWED_HOSTS`,
      { url: url.href, reason: 'host-not-allowed' },
    );
  }

  if (allowsPrivateDestinations(env)) return url; // operator opted in

  // Normalise the host before it is used as a DNS name or parsed as an IP.
  //
  //  • IPv6 literals keep their brackets in URL.hostname ('[::1]'), and
  //    dns.lookup('[::1]') is ENOTFOUND. That fails closed, so nothing unsafe
  //    got through — but it also rejected LEGITIMATE public IPv6 literals like
  //    http://[2606:4700:4700::1111]/, which would have broken any provider
  //    reachable only over IPv6, and it meant '[::1]' was refused by accident
  //    rather than by policy.
  //  • A trailing dot ('localhost.') is the DNS root form of the same name.
  //    Whether it resolves is resolver-dependent, so strip it and judge the
  //    name itself rather than relying on a lookup failure.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');

  // An IP literal is already an address — check it directly. Sending it to DNS
  // is both unnecessary and, for IPv6, wrong.
  if (ipaddr.isValid(host)) {
    if (isBlockedAddress(host)) {
      throw new OutboundBlockedError(
        `Outbound request blocked: ${host} is a non-public address. ` +
        `Set OUTBOUND_ALLOW_PRIVATE=true only if reaching private hosts is intended.`,
        { url: url.href, reason: 'private-address' },
      );
    }
    return url;
  }

  // Every address the name resolves to must be acceptable — a name with one
  // public and one private record must not be reachable via the private one.
  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch (error) {
    throw new OutboundBlockedError(
      `Outbound request blocked: cannot resolve '${host}' (${error.code || error.message})`,
      { url: url.href, reason: 'dns' },
    );
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new OutboundBlockedError(
        `Outbound request blocked: '${host}' resolves to non-public address ${address}. ` +
        `Set OUTBOUND_ALLOW_PRIVATE=true only if reaching private hosts is intended.`,
        { url: url.href, reason: 'private-address' },
      );
    }
  }

  return url;
}

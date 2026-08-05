// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Central outbound HTTP client. Service integrations must use this wrapper so
 * timeout and identification policy stay in one place. It deliberately uses
 * Node's standard fetch/connection pool: it does not support proxy routing,
 * TLS-fingerprint overrides, header-order controls, or impersonation.
 */
import { network } from '../config/network.config.js';
import { assertAllowedUrl } from './outboundGuard.js';

/** Redirect hops to follow before giving up. Each one is re-validated. */
const MAX_REDIRECTS = 5;

/** Statuses that mean "go here instead". 303 and 302→GET per fetch semantics. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NetworkClient {
  constructor({ timeoutMs = network.outboundRequestTimeoutMs, userAgent = network.outboundUserAgent, fetchImpl = null } = {}) {
    if (fetchImpl !== null && typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation must be a function');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async request(url, { headers, signal, ...init } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else if (signal) signal.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const finalizedHeaders = new Headers(headers);
      if (this.userAgent && !finalizedHeaders.has('user-agent')) {
        finalizedHeaders.set('user-agent', this.userAgent);
      }
      const fetchImpl = this.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') throw new TypeError('No fetch implementation is available');

      // ── Redirects are followed BY HAND so every hop is re-checked ─────────
      // `redirect: 'follow'` validates only the URL we were handed. A permitted
      // provider host answering 302 → http://169.254.169.254/… would be
      // followed silently, which defeats the egress policy entirely. Each hop
      // goes back through assertAllowedUrl instead.
      //
      // A caller that sets its own `redirect` gets what it asked for, and its
      // initial URL is still validated.
      const managed = init.redirect === undefined;
      let target = await assertAllowedUrl(url);
      let requestInit = { ...init, headers: finalizedHeaders, signal: controller.signal };
      if (!managed) return await fetchImpl(target, requestInit);

      requestInit.redirect = 'manual';
      for (let hop = 0; ; hop++) {
        const response = await fetchImpl(target, requestInit);
        // Status first: a non-redirect response must be handed back untouched,
        // without assuming it carries a `headers` object at all.
        if (!REDIRECT_STATUSES.has(response?.status)) return response;
        const location = response.headers?.get?.('location');
        if (!location) return response;
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Outbound request exceeded ${MAX_REDIRECTS} redirects (last: ${target})`);
        }
        // Relative Locations resolve against the hop we are on.
        target = await assertAllowedUrl(new URL(location, target).href);
        // Match fetch semantics: 301/302/303 turn a non-GET/HEAD into GET and
        // drop the body; 307/308 preserve both.
        const method = (requestInit.method || 'GET').toUpperCase();
        if (response.status !== 307 && response.status !== 308 && method !== 'GET' && method !== 'HEAD') {
          requestInit = { ...requestInit, method: 'GET', body: undefined };
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

export const networkClient = new NetworkClient();

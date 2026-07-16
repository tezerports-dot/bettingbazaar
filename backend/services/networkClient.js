// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Central outbound HTTP client. Service integrations must use this wrapper so
 * timeout and identification policy stay in one place. It deliberately uses
 * Node's standard fetch/connection pool: it does not support proxy routing,
 * TLS-fingerprint overrides, header-order controls, or impersonation.
 */
import { network } from '../config/network.config.js';

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
      return await fetchImpl(url, { ...init, headers: finalizedHeaders, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

export const networkClient = new NetworkClient();

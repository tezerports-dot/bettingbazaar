// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/secureTransport.ts — inside the Android app, every request to a
 * server goes through the native SecureHttp plugin, which resolves hostnames
 * over DNS-over-HTTPS (Cloudflare, then Google) and never through the phone's
 * own resolver (owner, 2026-10-10; CLAUDE.md §2 "How the Android app reaches
 * the network").
 *
 * ── Why it replaces fetch and EventSource ──────────────────────────────────
 * The WebView looks hostnames up itself and Android offers no way to change
 * how. So inside the native shell this module swaps the page's global `fetch`
 * and `EventSource` for versions that hand the request to
 * android/.../SecureHttpPlugin.java. Every caller — apiClient, realBackend's
 * request() and its one SSE stream, originFailover's probes and discovery, the
 * pages that call fetch(apiUrl(…)) directly, the profile-picture upload — keeps
 * its code and its error handling: what comes back is a real `Response`, a
 * transport failure is the same `TypeError` a browser throws, an abort is the
 * same `AbortError`.
 *
 * Only requests to ANOTHER origin are routed. The bundled app itself
 * (https://localhost) is served by the shell and stays on the browser's fetch.
 * On the web nothing is installed: `installSecureTransport` returns false
 * unless it is running in the Android shell with the plugin present.
 *
 * Not routed (the WebView loads these itself, with its own resolver): images,
 * stylesheets and fonts referenced from markup, and game iframes. They carry no
 * session token or money request.
 *
 * Installed by ./secureTransportInstall, the first import of index.tsx, so it
 * is in place before any module can start a request.
 */

/** Mirror of SecureHttpPlugin's request() answer (android/.../SecureHttpPlugin.java). */
export interface NativeResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string; // base64
  url: string;
  redirected: boolean;
}

/** Mirror of SecureHttpPlugin's "stream" event. */
export interface NativeStreamEvent {
  id: string;
  type: 'open' | 'data' | 'end';
  status?: number;
  headers?: [string, string][];
  text?: string;
  error?: string;
}

export interface SecureHttpPlugin {
  request(o: {
    id: string; url: string; method: string; headers: Record<string, string>;
    body?: string; redirect: 'follow' | 'error'; credentials: string; timeoutMs: number;
  }): Promise<NativeResult>;
  cancel(o: { id: string }): Promise<void>;
  openStream(o: {
    id: string; url: string; headers: Record<string, string>; credentials: string;
  }): Promise<void>;
  /** The shell's injected plugin answers synchronously; @capacitor/core's with a promise. */
  addListener(event: 'stream', cb: (e: NativeStreamEvent) => void): unknown;
}

/** The page's own origin and identity, as a browser would send them. */
export interface PageEnv {
  origin: string;      // window.location.origin — https://localhost in the shell
  userAgent: string;
}

// ── Base64 (bodies cross the bridge as text) ────────────────────────────────
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Statuses a Response may not carry a body for. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

let seq = 0;
const nextId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A request to another origin goes native; the bundle's own files do not. */
export function routesNatively(url: string, env: PageEnv): boolean {
  let u: URL;
  try { u = new URL(url, env.origin); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false; // data:, blob:…
  return u.origin !== env.origin;
}

function headersObject(h: Headers, env: PageEnv): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => { out[name] = value; });
  // What a browser adds to a cross-origin request. Origin is what the server's
  // CORS and origin checks already see from this app today.
  out.origin = env.origin;
  if (!out['user-agent']) out['user-agent'] = env.userAgent;
  if (!out.accept) out.accept = '*/*';
  return out;
}

export function buildResponse(r: NativeResult): Response {
  const headers = new Headers();
  for (const [name, value] of r.headers || []) {
    try { headers.append(name, value); } catch { /* a header a Response cannot hold */ }
  }
  const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
  const res = new Response(NULL_BODY_STATUS.has(status) ? null : base64ToBytes(r.body), {
    status, statusText: r.statusText || '', headers,
  });
  Object.defineProperty(res, 'url', { value: r.url, configurable: true });
  Object.defineProperty(res, 'redirected', { value: Boolean(r.redirected), configurable: true });
  return res;
}

// ── fetch ───────────────────────────────────────────────────────────────────
export function makeNativeFetch(
  plugin: SecureHttpPlugin,
  env: PageEnv,
  browserFetch: typeof fetch,
): typeof fetch {
  return async function secureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const href = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input);
    if (!routesNatively(href, env)) return browserFetch(input, init);

    // The browser's own Request normalises everything the callers pass —
    // header casing, a FormData or Blob body and its Content-Type — exactly as
    // fetch would have.
    const absolute = new URL(href, env.origin).href;
    const req = new Request(input instanceof Request ? input : absolute, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError();
    if (req.redirect === 'manual') {
      // An opaque redirect cannot be represented here; nothing in the app asks for one.
      throw new TypeError('Failed to fetch: redirect "manual" is not supported in the app');
    }

    const method = req.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : bytesToBase64(new Uint8Array(await req.arrayBuffer()));

    const id = nextId('req');
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        void plugin.cancel({ id }).catch(() => { /* already finished */ });
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      plugin.request({
        id,
        url: absolute,
        method,
        headers: headersObject(req.headers, env),
        ...(body !== undefined ? { body } : {}),
        redirect: req.redirect === 'error' ? 'error' : 'follow',
        credentials: req.credentials,
        timeoutMs: 0,
      }).then((r) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(buildResponse(r));
      }, (err: { code?: string; message?: string }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (err?.code === 'ABORTED') reject(abortError());
        // What a browser's fetch throws for DNS, TLS or connection failure —
        // the callers (apiClient, originFailover) branch on exactly this.
        else reject(new TypeError(`Failed to fetch${err?.message ? `: ${err.message}` : ''}`));
      });
    });
  };
}

// ── EventSource ─────────────────────────────────────────────────────────────
type Handler = ((this: EventSource, ev: Event) => unknown) | null;

/**
 * Server-sent events over the native stream, following the WHATWG
 * EventSource processing model: a non-200 or non-event-stream answer fails the
 * connection (CLOSED, no retry); a dropped stream reconnects after `retry`
 * with Last-Event-ID.
 */
export function makeNativeEventSource(
  plugin: SecureHttpPlugin,
  env: PageEnv,
  BrowserEventSource: typeof EventSource | undefined,
): typeof EventSource {
  const open = new Map<string, NativeEventSource>();
  let listening: Promise<unknown> | null = null;
  const listen = () => {
    listening ??= Promise.resolve(plugin.addListener('stream', (e) => open.get(e.id)?.handle(e)));
    return listening;
  };

  class NativeEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    readonly url: string;
    readonly withCredentials: boolean;
    readyState = 0;
    onopen: Handler = null;
    onmessage: Handler = null;
    onerror: Handler = null;

    private streamId: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private retryMs = 3000;
    private buf = '';
    private first = true;
    private data = '';
    private eventType = '';
    private lastEventId = '';
    private idBuffer = '';

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = new URL(String(url), env.origin).href;
      this.withCredentials = Boolean(init?.withCredentials);
      if (!routesNatively(this.url, env) && BrowserEventSource) {
        // Same origin: the browser's own, untouched.
        return new BrowserEventSource(this.url, init) as unknown as NativeEventSource;
      }
      void this.connect();
    }

    close(): void {
      this.readyState = 2;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.stopStream();
    }

    private stopStream(): void {
      if (!this.streamId) return;
      const id = this.streamId;
      open.delete(id);
      this.streamId = null;
      void plugin.cancel({ id }).catch(() => { /* already gone */ });
    }

    private async connect(): Promise<void> {
      if (this.readyState === 2) return;
      this.buf = ''; this.first = true; this.data = ''; this.eventType = '';
      const id = nextId('sse');
      this.streamId = id;
      open.set(id, this);
      const headers: Record<string, string> = {
        accept: 'text/event-stream', 'cache-control': 'no-cache',
        origin: env.origin, 'user-agent': env.userAgent,
      };
      if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
      try {
        await listen();
        if (this.streamId !== id) return; // closed while the listener registered
        await plugin.openStream({ id, url: this.url, headers, credentials: this.withCredentials ? 'include' : 'omit' });
      } catch {
        if (this.streamId === id) this.reestablish();
      }
    }

    /** Called with this stream's native events. */
    handle(e: NativeStreamEvent): void {
      if (e.id !== this.streamId || this.readyState === 2) return;
      if (e.type === 'open') {
        const type = (e.headers || []).find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '';
        if (e.status === 200 && /^text\/event-stream\b/i.test(type.trim())) {
          this.readyState = 1;
          this.fire(new Event('open'));
        } else {
          // Refused (401/403, a 5xx, the wrong type): failed, never retried.
          this.readyState = 2;
          this.stopStream();
          this.fire(new Event('error'));
        }
      } else if (e.type === 'data') {
        if (this.readyState === 1) this.parse(e.text || '');
      } else {
        this.stopStream();
        this.reestablish();
      }
    }

    private reestablish(): void {
      if (this.readyState === 2) return;
      this.streamId = null;
      this.readyState = 0;
      this.fire(new Event('error'));
      if (this.readyState === 2) return; // an error handler closed it
      this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, this.retryMs);
    }

    private fire(ev: Event): void {
      this.dispatchEvent(ev);
      const handler = ev.type === 'open' ? this.onopen : ev.type === 'error' ? this.onerror
        : ev.type === 'message' ? this.onmessage : null;
      handler?.call(this as unknown as EventSource, ev);
    }

    private parse(chunk: string): void {
      this.buf += chunk;
      if (this.first && this.buf.length > 0) {
        if (this.buf.charCodeAt(0) === 0xfeff) this.buf = this.buf.slice(1);
        this.first = false;
      }
      for (;;) {
        const m = /\r\n|\r|\n/.exec(this.buf);
        if (!m) return;
        // A lone \r at the very end may be the first half of \r\n.
        if (m[0] === '\r' && m.index === this.buf.length - 1) return;
        const line = this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.line(line);
        if (this.readyState === 2 || !this.streamId) return;
      }
    }

    private line(line: string): void {
      if (line === '') { this.dispatch(); return; }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.eventType = value;
      else if (field === 'data') this.data += `${value}\n`;
      else if (field === 'id') { if (!value.includes('\0')) this.idBuffer = value; }
      else if (field === 'retry') { if (/^\d+$/.test(value)) this.retryMs = Number(value); }
    }

    private dispatch(): void {
      this.lastEventId = this.idBuffer;
      if (this.data === '') { this.eventType = ''; return; }
      const data = this.data.endsWith('\n') ? this.data.slice(0, -1) : this.data;
      const type = this.eventType || 'message';
      this.data = ''; this.eventType = '';
      this.fire(new MessageEvent(type, { data, lastEventId: this.lastEventId, origin: new URL(this.url).origin }));
    }
  }

  return NativeEventSource as unknown as typeof EventSource;
}

// ── Installation ────────────────────────────────────────────────────────────
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { SecureHttp?: SecureHttpPlugin };
}

/**
 * Inside the Android shell, replace the page's fetch and EventSource. Returns
 * whether it did. Idempotent.
 *
 * The plugin is taken from `window.Capacitor.Plugins`, which the shell injects
 * (with every registered plugin's methods) BEFORE the bundle's first script
 * runs — so this works synchronously at boot, and the web bundle carries no
 * Capacitor code for it.
 */
export function installSecureTransport(w: Window & typeof globalThis = window): boolean {
  const cap = (w as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'android') return false;
  const plugin = cap.Plugins?.SecureHttp;
  if (!plugin) {
    // A shell without the plugin cannot keep the promise this module makes;
    // say so loudly rather than quietly using the system resolver.
    console.error('[secureTransport] SecureHttp plugin missing — requests use the system resolver');
    return false;
  }
  const marked = w as unknown as { __bbSecureTransport?: boolean };
  if (marked.__bbSecureTransport) return true;

  const env: PageEnv = { origin: w.location.origin, userAgent: w.navigator.userAgent };
  w.fetch = makeNativeFetch(plugin, env, w.fetch.bind(w));
  w.EventSource = makeNativeEventSource(plugin, env, w.EventSource);
  marked.__bbSecureTransport = true;
  return true;
}

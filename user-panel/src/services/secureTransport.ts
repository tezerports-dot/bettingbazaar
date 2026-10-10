// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/secureTransport.ts — the one door every request of this app goes
 * through (CLAUDE.md §2, "How the player app reaches the network").
 *
 * ── Why it exists ──────────────────────────────────────────────────────────
 * Inside the Android shell the screens run in a WebView, and the WebView looks
 * hostnames up with whatever DNS the phone's Wi-Fi or carrier hands it. It
 * offers no way to change that. So in the shell, a request to the API is not
 * sent by the WebView at all: it is handed to the native SecureHttp plugin
 * (android/.../SecureHttpPlugin.java), which sends it with the app's own HTTP
 * client and resolves the hostname over encrypted DNS (SecureDns.java: the
 * encrypted resolvers first, the phone's resolver only when none of them can
 * be reached). TLS is unchanged and still the guarantee: an address from a
 * hostile resolver leads to a server that cannot show our certificate.
 *
 *   secureFetch(url, init)   fetch(), with a real `Response` back
 *   openEventStream(url)     an EventSource (the live-updates stream)
 *
 * On the web, and for anything that is not an https request to another host
 * (the bundled assets at https://localhost, a dev server on http), both are
 * exactly `fetch` and `new EventSource`, called at the moment of the request.
 *
 * ── What it does not cover ─────────────────────────────────────────────────
 * Things the WebView itself loads: <img> sources, a game provider's page in an
 * iframe, links opened in the browser. None of them carries a request the
 * player signs; they stay on the phone's DNS, with TLS.
 *
 * The lint forbids `fetch`, `EventSource`, `XMLHttpRequest`, `WebSocket` and
 * `navigator.sendBeacon` anywhere else in src/ (eslint.config.js), so a new
 * call site cannot quietly go around this.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { isNativeShell } from './nativeLifecycle';

interface NativeResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
}

interface StreamMessage {
  id: string;
  kind: 'open' | 'message' | 'error';
  type?: string;
  data?: string;
  lastEventId?: string;
  /** On 'error': true when the server refused the stream (EventSource then stays closed). */
  fatal?: boolean;
  status?: number;
}

interface SecureHttpPlugin {
  request(o: {
    id: string; url: string; method: string; headers: Record<string, string>;
    redirect: RequestRedirect; bodyText?: string; bodyBase64?: string;
  }): Promise<NativeResponse>;
  cancel(o: { id: string }): Promise<void>;
  openStream(o: { id: string; url: string; headers: Record<string, string> }): Promise<void>;
  closeStream(o: { id: string }): Promise<void>;
  addListener(event: 'streamEvent', cb: (m: StreamMessage) => void): Promise<PluginListenerHandle>;
}

// ── The plugin ────────────────────────────────────────────────────────────────
// undefined: not looked up yet; null: not available (web, or a shell without it).
let resolved: SecureHttpPlugin | null | undefined;
let lookup: Promise<SecureHttpPlugin | null> | null = null;

function nativePlugin(): Promise<SecureHttpPlugin | null> {
  if (!lookup) {
    lookup = (async () => {
      try {
        // Imported lazily, as nativeUpdater.ts does, so the web bundle never
        // loads the native bridge.
        const { Capacitor, registerPlugin } = await import('@capacitor/core');
        if (!Capacitor.isPluginAvailable('SecureHttp')) {
          // The plugin ships in the same APK as this bundle, so this is a broken
          // build. Requests still go out (through the WebView) rather than none.
          console.error('[transport] SecureHttp plugin missing: requests use the WebView resolver');
          return (resolved = null);
        }
        return (resolved = registerPlugin<SecureHttpPlugin>('SecureHttp'));
      } catch (err) {
        console.error('[transport] native bridge unavailable:', err);
        return (resolved = null);
      }
    })();
  }
  return lookup;
}

/** Sent natively: an absolute https URL on another host than the page's own. */
export function routesNatively(url: string): boolean {
  let u: URL;
  try { u = new URL(url, window.location.href); } catch { return false; }
  return u.protocol === 'https:' && u.host !== window.location.host;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

// ── fetch ─────────────────────────────────────────────────────────────────────
/**
 * `fetch`, through the encrypted-DNS transport inside the Android shell.
 *
 * Same contract as fetch: resolves with a `Response` for any HTTP status,
 * rejects with a TypeError when the server could not be reached, and with the
 * signal's AbortError when aborted. Cookies are not sent natively (the WebView
 * never kept the API's cross-site cookies either); requests carry their
 * Authorization header.
 */
export async function secureFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!isNativeShell() || !routesNatively(url)) return webFetch(input, init);
  const native = resolved === undefined ? await nativePlugin() : resolved;
  if (!native) return webFetch(input, init);
  return nativeFetch(native, new URL(url, window.location.href).toString(), init ?? {});
}

/** The page's own fetch, given exactly the arguments the caller gave. */
function webFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function nativeFetch(native: SecureHttpPlugin, url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortReason(signal);

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  const body = await encodeBody(init.body, headers);
  if (signal?.aborted) throw abortReason(signal);

  const id = nextId();
  const sent = native.request({
    id, url, headers, ...body,
    method: (init.method || 'GET').toUpperCase(),
    redirect: init.redirect || 'follow',
  });

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      void native.cancel({ id }).catch(() => { /* already finished */ });
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return toResponse(await (signal ? Promise.race([sent, aborted]) : sent));
  } catch (err) {
    if (signal?.aborted) throw abortReason(signal);
    // The shape fetch rejects with, so every caller's transport-failure path
    // (apiClient's failover, discovery's 'unreachable') is the one it was.
    throw Object.assign(new TypeError('Failed to fetch'), { cause: err });
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** The request body as the plugin carries it; sets the content type fetch would. */
async function encodeBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>,
): Promise<{ bodyText?: string; bodyBase64?: string }> {
  if (body == null) return {};
  const defaultType = (type: string) => { if (type && !('content-type' in headers)) headers['content-type'] = type; };
  if (typeof body === 'string') {
    defaultType('text/plain;charset=UTF-8');
    return { bodyText: body };
  }
  if (body instanceof URLSearchParams) {
    defaultType('application/x-www-form-urlencoded;charset=UTF-8');
    return { bodyText: body.toString() };
  }
  if (body instanceof Blob) {
    defaultType(body.type);
    return { bodyBase64: toBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) return { bodyBase64: toBase64(new Uint8Array(body)) };
  if (ArrayBuffer.isView(body)) return { bodyBase64: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
  // FormData and streams: nothing in this app sends one. Refuse loudly rather
  // than send it some other way.
  throw new TypeError('secureFetch: this body type is not supported');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Statuses whose Response may not carry a body (the constructor throws otherwise). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toResponse(r: NativeResponse): Response {
  const body = NULL_BODY.has(r.status) ? null
    : r.bodyBase64 != null ? fromBase64(r.bodyBase64)
    : (r.bodyText ?? '');
  const response = new Response(body as BodyInit | null, { status: r.status, statusText: r.statusText, headers: r.headers });
  Object.defineProperty(response, 'url', { value: r.url });
  return response;
}

// ── EventSource ───────────────────────────────────────────────────────────────
/** What this app uses of an EventSource; the browser's and the native one both satisfy it. */
export interface EventStream extends EventTarget {
  readonly readyState: number;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSED: 2;
  onopen: ((this: EventSource, ev: Event) => unknown) | null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null;
  close(): void;
}

/**
 * The live-updates stream, through the encrypted-DNS transport inside the
 * Android shell; `new EventSource(url)` everywhere else.
 */
export function openEventStream(url: string): EventStream {
  if (!isNativeShell() || !routesNatively(url) || resolved === null) return new EventSource(url);
  return new NativeEventSource(new URL(url, window.location.href).toString());
}

/**
 * The gap before reconnecting a dropped stream. A browser uses the server's
 * `retry:` field; the server sends 3000 on every stream, and the native SSE
 * reader does not surface the field, so it is the same number here (§11:
 * transport timing, no business value).
 */
const RECONNECT_MS = 3000;

const streams = new Map<string, NativeEventSource>();
let streamListener: Promise<unknown> | null = null;

function listenToStreams(native: SecureHttpPlugin): Promise<unknown> {
  if (!streamListener) {
    streamListener = native.addListener('streamEvent', (m) => streams.get(m.id)?.receive(m));
  }
  return streamListener;
}

/**
 * The browser EventSource's behaviour, over the native stream: CONNECTING →
 * OPEN; a dropped connection fires `error` and reconnects (sending
 * Last-Event-ID); a refused one (not 200, not an event stream) fires `error`
 * and stays CLOSED. realBackend's SSE bridge depends on exactly that split.
 */
class NativeEventSource extends EventTarget implements EventStream {
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  readyState: number = 0;
  onopen: EventStream['onopen'] = null;
  onerror: EventStream['onerror'] = null;
  onmessage: EventStream['onmessage'] = null;

  private id: string | null = null;
  private lastEventId = '';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private native: SecureHttpPlugin | null = null;

  constructor(readonly url: string) {
    super();
    void this.connect();
  }

  private async connect(): Promise<void> {
    const native = resolved === undefined ? await nativePlugin() : resolved;
    if (this.readyState === this.CLOSED) return;
    if (!native) { this.drop(true); return; }   // the caller's retry opens a browser EventSource
    this.native = native;
    await listenToStreams(native);
    if (this.readyState === this.CLOSED) return;

    const id = nextId();
    this.id = id;
    streams.set(id, this);
    const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    try {
      await native.openStream({ id, url: this.url, headers });
    } catch {
      this.receive({ id, kind: 'error', fatal: false });
    }
  }

  receive(m: StreamMessage): void {
    if (m.id !== this.id || this.readyState === this.CLOSED) return;
    if (m.kind === 'open') {
      this.readyState = this.OPEN;
      this.emit(new Event('open'));
    } else if (m.kind === 'message') {
      if (m.lastEventId) this.lastEventId = m.lastEventId;
      this.emit(new MessageEvent(m.type || 'message', {
        data: m.data ?? '', lastEventId: this.lastEventId, origin: new URL(this.url).origin,
      }));
    } else {
      this.drop(Boolean(m.fatal));
    }
  }

  close(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.readyState = this.CLOSED;
    this.release();
  }

  private drop(fatal: boolean): void {
    this.release();
    if (fatal) {
      this.readyState = this.CLOSED;
    } else {
      this.readyState = this.CONNECTING;
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, RECONNECT_MS);
    }
    this.emit(new Event('error'));
  }

  private release(): void {
    if (!this.id) return;
    const id = this.id;
    streams.delete(id);
    this.id = null;
    void this.native?.closeStream({ id }).catch(() => { /* already gone */ });
  }

  private emit(ev: Event): void {
    this.dispatchEvent(ev);
    const handler = ev.type === 'open' ? this.onopen : ev.type === 'error' ? this.onerror
      : ev.type === 'message' ? this.onmessage : null;
    try {
      (handler as ((e: Event) => unknown) | null)?.call(this as unknown as EventSource, ev);
    } catch (err) {
      console.error('[transport] stream handler threw:', err);
    }
  }
}

/** Test seam: forget the looked-up plugin. */
export function __resetSecureTransportForTests(): void {
  resolved = undefined;
  lookup = null;
  streamListener = null;
  streams.clear();
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * secureTransport: inside the Android app every request to the API leaves
 * through the native DNS-over-HTTPS client, and every caller still sees what a
 * browser's fetch / EventSource would have given it. The native side is
 * android/.../SecureTransportTest.java; this is the page's half.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeNativeFetch, makeNativeEventSource, installSecureTransport, routesNatively,
  bytesToBase64, base64ToBytes,
  type SecureHttpPlugin, type NativeResult, type NativeStreamEvent, type PageEnv,
} from './secureTransport';

const ENV: PageEnv = { origin: 'https://localhost', userAgent: 'BB-Test/1.0' };
const API = 'https://api.example.com';
const enc = new TextEncoder();
const b64 = (s: string) => bytesToBase64(enc.encode(s));

function ok(body = '', over: Partial<NativeResult> = {}): NativeResult {
  return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: b64(body), url: `${API}/x`, redirected: false, ...over };
}

/** A fake SecureHttp plugin: records every call; the test decides answers. */
function fakePlugin() {
  let streamCb: ((e: NativeStreamEvent) => void) | null = null;
  const pending = new Map<string, { resolve: (r: NativeResult) => void; reject: (e: unknown) => void }>();
  const plugin = {
    request: vi.fn((o: Parameters<SecureHttpPlugin['request']>[0]) =>
      new Promise<NativeResult>((resolve, reject) => { pending.set(o.id, { resolve, reject }); })),
    cancel: vi.fn(async (_o: { id: string }) => {}),
    openStream: vi.fn(async (_o: Parameters<SecureHttpPlugin['openStream']>[0]) => {}),
    addListener: vi.fn((_ev: 'stream', cb: (e: NativeStreamEvent) => void) => { streamCb = cb; return { remove: async () => {} }; }),
  };
  return {
    plugin: plugin as unknown as SecureHttpPlugin & typeof plugin,
    answer(r: NativeResult) { const [id, p] = [...pending][pending.size - 1]; pending.delete(id); p.resolve(r); },
    fail(code: string, message = 'boom') { const [id, p] = [...pending][pending.size - 1]; pending.delete(id); p.reject(Object.assign(new Error(message), { code })); },
    stream(e: NativeStreamEvent) { streamCb?.(e); },
    lastRequest() { return plugin.request.mock.calls[plugin.request.mock.calls.length - 1][0]; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('which requests go native', () => {
  it('routes another origin, never the bundle itself or non-http schemes', () => {
    expect(routesNatively(`${API}/api/v1/boards`, ENV)).toBe(true);
    expect(routesNatively('http://api.example.com/x', ENV)).toBe(true); // refused natively, not leaked to the WebView
    expect(routesNatively('/api/announcements', ENV)).toBe(false);
    expect(routesNatively('https://localhost/assets/a.js', ENV)).toBe(false);
    expect(routesNatively('data:text/plain,hi', ENV)).toBe(false);
    expect(routesNatively('blob:https://localhost/1', ENV)).toBe(false);
  });
});

describe('native fetch', () => {
  let f: ReturnType<typeof fakePlugin>;
  let browserFetch: ReturnType<typeof vi.fn>;
  let fetchNative: typeof fetch;

  beforeEach(() => {
    f = fakePlugin();
    browserFetch = vi.fn(async () => new Response('local'));
    fetchNative = makeNativeFetch(f.plugin, ENV, browserFetch as unknown as typeof fetch);
  });

  it('leaves the bundle\'s own requests to the browser', async () => {
    const r = await fetchNative('/manifest.json');
    expect(await r.text()).toBe('local');
    expect(browserFetch).toHaveBeenCalledOnce();
    expect(f.plugin.request).not.toHaveBeenCalled();
  });

  it('sends an API call natively with its method, headers, body and credentials, and returns a real Response', async () => {
    const p = fetchNative(`${API}/api/bet/place`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t0k' },
      body: JSON.stringify({ side: 'DELHI', amount: 100 }),
    });
    await flush();
    const sent = f.lastRequest();
    expect(sent.url).toBe(`${API}/api/bet/place`);
    expect(sent.method).toBe('POST');
    expect(sent.credentials).toBe('include');
    expect(sent.redirect).toBe('follow');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.authorization).toBe('Bearer t0k');
    expect(sent.headers.origin).toBe('https://localhost');
    expect(sent.headers['user-agent']).toBe('BB-Test/1.0');
    expect(new TextDecoder().decode(base64ToBytes(sent.body!))).toBe('{"side":"DELHI","amount":100}');
    expect(browserFetch).not.toHaveBeenCalled();

    f.answer(ok('{"success":true}', { status: 201, statusText: 'Created', url: `${API}/api/bet/place` }));
    const res = await p;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.url).toBe(`${API}/api/bet/place`);
    expect(await res.json()).toEqual({ success: true });
  });

  it('carries the origin-failover options: redirect error and no credentials', async () => {
    const p = fetchNative(`${API}/health/live`, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    await flush();
    expect(f.lastRequest()).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'GET' });
    expect(f.lastRequest().body).toBeUndefined();
    f.answer(ok(''));
    expect((await p).ok).toBe(true);
  });

  it('keeps binary bodies byte-exact in both directions', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 10, 13]);
    const p = fetchNative(`${API}/upload`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
    await flush();
    expect([...base64ToBytes(f.lastRequest().body!)]).toEqual([...bytes]);
    f.answer(ok('', { body: bytesToBase64(bytes), headers: [['content-type', 'application/octet-stream']] }));
    expect([...new Uint8Array(await (await p).arrayBuffer())]).toEqual([...bytes]);
  });

  it('accepts a Request object', async () => {
    const p = fetchNative(new Request(`${API}/api/announcements`, { method: 'DELETE', headers: { 'X-A': '1' } }));
    await flush();
    expect(f.lastRequest()).toMatchObject({ method: 'DELETE', url: `${API}/api/announcements` });
    expect(f.lastRequest().headers['x-a']).toBe('1');
    f.answer(ok('{}'));
    await p;
  });

  it('gives a 204 an empty body rather than throwing', async () => {
    const p = fetchNative(`${API}/api/user/notifications/read`, { method: 'POST' });
    await flush();
    f.answer(ok('', { status: 204, statusText: 'No Content' }));
    const res = await p;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('passes HTTP errors through as responses, as fetch does', async () => {
    const p = fetchNative(`${API}/api/announcements`);
    await flush();
    f.answer(ok('{"error":"nope"}', { status: 401, statusText: 'Unauthorized' }));
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('turns a native network failure (DoH or TLS) into the TypeError a browser throws', async () => {
    const p = fetchNative(`${API}/api/announcements`);
    await flush();
    f.fail('NETWORK', 'api.example.com could not be resolved over HTTPS by any provider');
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(String(err.message)).toMatch(/^Failed to fetch/);
  });

  it('aborts: the page gets AbortError at once and the native request is cancelled', async () => {
    const ctl = new AbortController();
    const p = fetchNative(`${API}/api/announcements`, { signal: ctl.signal });
    await flush();
    const id = f.lastRequest().id;
    ctl.abort();
    const err = await p.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(f.plugin.cancel).toHaveBeenCalledWith({ id });
    f.answer(ok('late')); // a late answer changes nothing
  });

  it('refuses an already-aborted signal without sending', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await fetchNative(`${API}/api/announcements`, { signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(f.plugin.request).not.toHaveBeenCalled();
  });

  it('maps a native ABORTED rejection to AbortError', async () => {
    const p = fetchNative(`${API}/api/announcements`);
    await flush();
    f.fail('ABORTED');
    expect((await p.catch((e) => e)).name).toBe('AbortError');
  });
});

describe('native EventSource', () => {
  let f: ReturnType<typeof fakePlugin>;
  let ES: typeof EventSource;
  let BrowserES: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    f = fakePlugin();
    BrowserES = vi.fn(function (this: unknown, url: string) { return { browser: true, url }; });
    ES = makeNativeEventSource(f.plugin, ENV, BrowserES as unknown as typeof EventSource);
  });
  afterEach(() => { vi.useRealTimers(); });

  async function opened(url = `${API}/api/sse/events`, init?: EventSourceInit) {
    const es = new ES(url, init);
    await flush();
    const id = f.plugin.openStream.mock.calls[f.plugin.openStream.mock.calls.length - 1][0].id;
    return { es, id };
  }
  const openOk = (id: string) => f.stream({ id, type: 'open', status: 200, headers: [['Content-Type', 'text/event-stream; charset=utf-8']] });

  it('exposes the constants the realtime bridge reads', () => {
    expect(ES.CONNECTING).toBe(0);
    expect(ES.OPEN).toBe(1);
    expect(ES.CLOSED).toBe(2);
  });

  it('leaves a same-origin stream to the browser', () => {
    const es = new ES('/api/sse/events') as unknown as { browser: boolean };
    expect(es.browser).toBe(true);
    expect(f.plugin.openStream).not.toHaveBeenCalled();
  });

  it('opens the stream natively, without cookies unless asked', async () => {
    const { id } = await opened(`${API}/api/sse/player/events?token=abc`);
    const call = f.plugin.openStream.mock.calls[0][0];
    expect(call).toMatchObject({ id, url: `${API}/api/sse/player/events?token=abc`, credentials: 'omit' });
    expect(call.headers.accept).toBe('text/event-stream');
    expect(call.headers.origin).toBe('https://localhost');
    await opened(`${API}/api/sse/events`, { withCredentials: true });
    expect(f.plugin.openStream.mock.calls[1][0].credentials).toBe('include');
  });

  it('parses events split anywhere, CRLF or LF, named or not, multi-line, with ids and comments', async () => {
    const { es, id } = await opened();
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const pools: MessageEvent[] = [];
    es.onopen = onopen;
    es.onmessage = onmessage;
    es.addEventListener('pool_update', (e) => pools.push(e as MessageEvent));

    openOk(id);
    expect(es.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledOnce();

    const stream = '﻿: hello\r\nretry: 5000\r\n\r\nevent: pool_update\r\nid: 7\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: plain\n\n';
    for (const piece of [stream.slice(0, 5), stream.slice(5, 31), stream.slice(31, 32), stream.slice(32, 60), stream.slice(60)]) {
      f.stream({ id, type: 'data', text: piece });
    }
    expect(pools).toHaveLength(1);
    expect(pools[0].data).toBe('{"a":\n1}');
    expect(pools[0].lastEventId).toBe('7');
    expect(pools[0].origin).toBe(API);
    expect(onmessage).toHaveBeenCalledOnce();
    expect(onmessage.mock.calls[0][0].data).toBe('plain');
  });

  it('a \\r at the end of one chunk and \\n at the start of the next is one line break', async () => {
    const { es, id } = await opened();
    const got: string[] = [];
    es.onmessage = (e) => got.push((e as MessageEvent).data);
    openOk(id);
    f.stream({ id, type: 'data', text: 'data: a\r' });
    f.stream({ id, type: 'data', text: '\ndata: b\r\n\r\n' });
    // Read as two breaks, the \n would be an empty line and end the event early.
    expect(got).toEqual(['a\nb']);
  });

  it('a refused stream (401, or not an event stream) is CLOSED and never retried', async () => {
    vi.useFakeTimers();
    const es = new ES(`${API}/api/sse/player/events?token=old`);
    await vi.advanceTimersByTimeAsync(0);
    const id = f.plugin.openStream.mock.calls[0][0].id;
    const onerror = vi.fn();
    es.onerror = onerror;
    f.stream({ id, type: 'open', status: 401, headers: [['content-type', 'application/json']] });
    expect(es.readyState).toBe(2);
    expect(onerror).toHaveBeenCalledOnce();
    expect(f.plugin.cancel).toHaveBeenCalledWith({ id });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.plugin.openStream).toHaveBeenCalledOnce();

    // A 401 is refused even when it claims to be an event stream.
    const es2 = new ES(`${API}/api/sse/player/events?token=old`);
    await vi.advanceTimersByTimeAsync(0);
    const id2 = f.plugin.openStream.mock.calls[1][0].id;
    f.stream({ id: id2, type: 'open', status: 401, headers: [['content-type', 'text/event-stream']] });
    expect(es2.readyState).toBe(2);
    // And a 200 that is not an event stream is refused too.
    const es3 = new ES(`${API}/api/sse/events`);
    await vi.advanceTimersByTimeAsync(0);
    const id3 = f.plugin.openStream.mock.calls[2][0].id;
    f.stream({ id: id3, type: 'open', status: 200, headers: [['content-type', 'text/html']] });
    expect(es3.readyState).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.plugin.openStream).toHaveBeenCalledTimes(3);
  });

  it('a dropped stream reconnects after `retry`, sending Last-Event-ID', async () => {
    vi.useFakeTimers();
    const es = new ES(`${API}/api/sse/events`);
    await vi.advanceTimersByTimeAsync(0);
    const id = f.plugin.openStream.mock.calls[0][0].id;
    const onerror = vi.fn();
    es.onerror = onerror;
    openOk(id);
    f.stream({ id, type: 'data', text: 'retry: 250\nid: 42\ndata: hi\n\n' });
    f.stream({ id, type: 'end', error: 'connection reset' });
    expect(es.readyState).toBe(0);
    expect(onerror).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(249);
    expect(f.plugin.openStream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.plugin.openStream).toHaveBeenCalledTimes(2);
    expect(f.plugin.openStream.mock.calls[1][0].headers['last-event-id']).toBe('42');

    // Events from the old stream are ignored once it is replaced.
    const got = vi.fn();
    es.onmessage = got;
    f.stream({ id, type: 'data', text: 'data: stale\n\n' });
    expect(got).not.toHaveBeenCalled();
  });

  it('close() cancels the native stream and stops everything', async () => {
    vi.useFakeTimers();
    const es = new ES(`${API}/api/sse/events`);
    await vi.advanceTimersByTimeAsync(0);
    const id = f.plugin.openStream.mock.calls[0][0].id;
    openOk(id);
    const got = vi.fn();
    es.onmessage = got;
    es.close();
    expect(es.readyState).toBe(2);
    expect(f.plugin.cancel).toHaveBeenCalledWith({ id });
    f.stream({ id, type: 'data', text: 'data: after\n\n' });
    f.stream({ id, type: 'end' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(got).not.toHaveBeenCalled();
    expect(f.plugin.openStream).toHaveBeenCalledOnce();
  });

  it('an error handler that closes the stream prevents the reconnect', async () => {
    vi.useFakeTimers();
    const es = new ES(`${API}/api/sse/events`);
    await vi.advanceTimersByTimeAsync(0);
    const id = f.plugin.openStream.mock.calls[0][0].id;
    openOk(id);
    es.onerror = () => es.close();
    f.stream({ id, type: 'end' });
    expect(vi.getTimerCount()).toBe(0); // no reconnect left scheduled
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.plugin.openStream).toHaveBeenCalledOnce();
  });
});

describe('installation', () => {
  function fakeWindow(cap: unknown) {
    const original = vi.fn();
    const OriginalES = vi.fn();
    const w = {
      Capacitor: cap, fetch: original, EventSource: OriginalES,
      location: { origin: 'https://localhost' }, navigator: { userAgent: 'UA' },
    };
    return { w: w as unknown as Window & typeof globalThis, original, OriginalES };
  }
  const plugin = fakePlugin().plugin;

  it('does nothing on the web', () => {
    const { w, original } = fakeWindow(undefined);
    expect(installSecureTransport(w)).toBe(false);
    expect(w.fetch).toBe(original);
    const web = fakeWindow({ isNativePlatform: () => false, getPlatform: () => 'web' });
    expect(installSecureTransport(web.w)).toBe(false);
  });

  it('in the Android shell, replaces fetch and EventSource once', () => {
    const { w, original, OriginalES } = fakeWindow({
      isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { SecureHttp: plugin },
    });
    expect(installSecureTransport(w)).toBe(true);
    expect(w.fetch).not.toBe(original);
    expect(w.EventSource).not.toBe(OriginalES);
    const installed = w.fetch;
    expect(installSecureTransport(w)).toBe(true);
    expect(w.fetch).toBe(installed);
  });

  it('says so loudly when the shell has no SecureHttp plugin', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, original } = fakeWindow({ isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} });
    expect(installSecureTransport(w)).toBe(false);
    expect(w.fetch).toBe(original);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

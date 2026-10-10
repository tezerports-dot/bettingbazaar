// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The app's one request door (secureTransport.ts). In the Android shell an
 * https request to the API must leave through the native SecureHttp plugin
 * (encrypted DNS), and come back as the same `Response` / EventSource the
 * callers were written against. On the web nothing may change at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = {
  request: vi.fn(),
  cancel: vi.fn(async (_o: any) => {}),
  openStream: vi.fn(async (_o: any) => {}),
  closeStream: vi.fn(async (_o: any) => {}),
  addListener: vi.fn(),
};
let available = true;
let streamCb: ((m: any) => void) | null = null;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: (name: string) => available && name === 'SecureHttp' },
  registerPlugin: () => plugin,
}));

import { secureFetch, openEventStream, routesNatively, __resetSecureTransportForTests } from './secureTransport';

const API = 'https://api.example.com';

function native(on: boolean) {
  (window as any).Capacitor = on ? { isNativePlatform: () => true } : undefined;
}

function answer(over: Partial<{ status: number; statusText: string; headers: Record<string, string>; bodyText: string; bodyBase64: string }> = {}) {
  return { status: 200, statusText: 'OK', url: `${API}/x`, headers: { 'content-type': 'application/json' }, bodyText: '{"ok":true}', ...over };
}

beforeEach(() => {
  __resetSecureTransportForTests();
  available = true;
  streamCb = null;
  plugin.request.mockReset();
  plugin.cancel.mockClear();
  plugin.openStream.mockClear();
  plugin.closeStream.mockClear();
  plugin.addListener.mockReset().mockImplementation(async (_e: string, cb: (m: any) => void) => { streamCb = cb; return { remove: async () => {} }; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('web')));
});

afterEach(() => {
  native(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('on the web', () => {
  it('is exactly fetch, with exactly the caller\'s arguments', async () => {
    native(false);
    await secureFetch(`${API}/a`);
    await secureFetch(`${API}/b`, { method: 'POST', body: '{}' });
    expect((fetch as any).mock.calls[0]).toEqual([`${API}/a`]);
    expect((fetch as any).mock.calls[1]).toEqual([`${API}/b`, { method: 'POST', body: '{}' }]);
    expect(plugin.request).not.toHaveBeenCalled();
  });

  it('is exactly new EventSource', () => {
    native(false);
    const Fake = vi.fn(function (this: any, url: string) { this.url = url; });
    vi.stubGlobal('EventSource', Fake);
    const es = openEventStream(`${API}/api/sse/events`);
    expect(Fake).toHaveBeenCalledWith(`${API}/api/sse/events`);
    expect((es as any).url).toBe(`${API}/api/sse/events`);
  });
});

describe('in the Android shell', () => {
  beforeEach(() => native(true));

  it('sends an https request to the API through the native plugin, not the WebView', async () => {
    plugin.request.mockResolvedValue(answer({ status: 201, headers: { 'content-type': 'application/json', 'x-request-id': 'r1' } }));
    const res = await secureFetch(`${API}/api/bet/place`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ amount: 10 }),
      credentials: 'include',
    });
    expect(fetch).not.toHaveBeenCalled();
    const sent = plugin.request.mock.calls[0][0];
    expect(sent).toMatchObject({
      url: `${API}/api/bet/place`, method: 'POST', redirect: 'follow',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      bodyText: '{"amount":10}',
    });
    expect(sent.bodyBase64).toBeUndefined();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(res.url).toBe(`${API}/x`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps the bundled app\'s own files and plain-http dev servers on the WebView', async () => {
    await secureFetch('/assets/logo.png');
    await secureFetch(`${window.location.origin}/index.html`);
    await secureFetch('http://localhost:8080/api/x');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(plugin.request).not.toHaveBeenCalled();
    expect(routesNatively(`${API}/x`)).toBe(true);
    expect(routesNatively('not a url at all://')).toBe(false);
  });

  it('answers an HTTP error as a Response, the way fetch does, not as a rejection', async () => {
    plugin.request.mockResolvedValue(answer({ status: 401, statusText: '', bodyText: '{"code":"NO"}' }));
    const res = await secureFetch(`${API}/api/v1/auth/me`);
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect((await res.json()).code).toBe('NO');
  });

  it('gives a 204 an empty body instead of throwing', async () => {
    plugin.request.mockResolvedValue(answer({ status: 204, bodyText: '' }));
    const res = await secureFetch(`${API}/api/x`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('carries a file upload as bytes, with the file\'s type', async () => {
    plugin.request.mockResolvedValue(answer({ bodyText: '' }));
    const file = new Blob([new Uint8Array([0, 1, 2, 250, 255])], { type: 'image/png' });
    await secureFetch('https://uploads.example.com/put?sig=1', { method: 'PUT', body: file });
    const sent = plugin.request.mock.calls[0][0];
    expect(sent.headers['content-type']).toBe('image/png');
    expect(sent.bodyText).toBeUndefined();
    expect(Array.from(atob(sent.bodyBase64), (c) => c.charCodeAt(0))).toEqual([0, 1, 2, 250, 255]);
  });

  it('returns a binary answer byte for byte', async () => {
    plugin.request.mockResolvedValue(answer({ headers: { 'content-type': 'application/octet-stream' }, bodyText: undefined, bodyBase64: btoa(String.fromCharCode(9, 0, 200)) }));
    const res = await secureFetch(`${API}/file`);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([9, 0, 200]);
  });

  it('rejects an unreachable server with the TypeError fetch uses, so failover still sees a transport failure', async () => {
    plugin.request.mockRejectedValue(Object.assign(new Error('The request could not reach the server.'), { code: 'NETWORK' }));
    await expect(secureFetch(`${API}/health/live`)).rejects.toBeInstanceOf(TypeError);
  });

  it('passes redirect refusal through to the native side', async () => {
    plugin.request.mockResolvedValue(answer());
    await secureFetch(`${API}/discover`, { redirect: 'error' });
    expect(plugin.request.mock.calls[0][0].redirect).toBe('error');
  });

  it('aborts: rejects with the AbortError and cancels the native request', async () => {
    plugin.request.mockImplementation(() => new Promise(() => {}));   // never answers
    const controller = new AbortController();
    const pending = secureFetch(`${API}/health/live`, { signal: controller.signal });
    await vi.waitFor(() => expect(plugin.request).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(plugin.cancel).toHaveBeenCalledWith({ id: plugin.request.mock.calls[0][0].id });
  });

  it('never sends a request whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(secureFetch(`${API}/x`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(plugin.request).not.toHaveBeenCalled();
  });

  it('still reaches the server through the WebView if the plugin is missing from the build', async () => {
    available = false;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await secureFetch(`${API}/x`);
    expect(fetch).toHaveBeenCalledWith(`${API}/x`);
    expect(err).toHaveBeenCalled();
  });
});

describe('the live stream in the Android shell', () => {
  beforeEach(() => native(true));

  async function opened(url = `${API}/api/sse/events`) {
    const es = openEventStream(url);
    await vi.waitFor(() => expect(plugin.openStream).toHaveBeenCalled());
    const calls = plugin.openStream.mock.calls;
    const { id } = calls[calls.length - 1][0];
    return { es, id };
  }

  it('opens natively and delivers named events as MessageEvents', async () => {
    const { es, id } = await opened();
    expect(plugin.openStream.mock.calls[0][0]).toMatchObject({ url: `${API}/api/sse/events`, headers: { Accept: 'text/event-stream' } });
    const onopen = vi.fn();
    es.onopen = onopen;
    const heard: MessageEvent[] = [];
    es.addEventListener('cycle_snapshot', (e) => heard.push(e as MessageEvent));

    streamCb!({ id, kind: 'open', status: 200 });
    expect(es.readyState).toBe(es.OPEN);
    expect(onopen).toHaveBeenCalled();

    streamCb!({ id, kind: 'message', type: 'cycle_snapshot', data: '{"n":1}', lastEventId: '7' });
    expect(heard).toHaveLength(1);
    expect(JSON.parse(heard[0].data)).toEqual({ n: 1 });
    expect(heard[0].lastEventId).toBe('7');

    // Another stream's events are not this one's.
    streamCb!({ id: 'someone-else', kind: 'message', type: 'cycle_snapshot', data: '{}' });
    expect(heard).toHaveLength(1);
  });

  it('a dropped stream reports an error, stays CONNECTING and reconnects with Last-Event-ID', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { es, id } = await opened();
    streamCb!({ id, kind: 'open' });
    streamCb!({ id, kind: 'message', type: 'message', data: 'x', lastEventId: '42' });
    const onerror = vi.fn();
    es.onerror = onerror;

    streamCb!({ id, kind: 'error', fatal: false });
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(es.readyState).toBe(es.CONNECTING);
    expect(plugin.openStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(plugin.openStream).toHaveBeenCalledTimes(2);
    const again = plugin.openStream.mock.calls[1][0] as any;
    expect(again.id).not.toBe(id);
    expect(again.headers['Last-Event-ID']).toBe('42');
  });

  it('a refused stream (401, 5xx) is CLOSED and not retried, as a browser does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { es, id } = await opened();
    const onerror = vi.fn();
    es.onerror = onerror;
    streamCb!({ id, kind: 'error', fatal: true, status: 401 });
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(es.readyState).toBe(es.CLOSED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plugin.openStream).toHaveBeenCalledTimes(1);
  });

  it('close() ends the native stream and ignores anything after it', async () => {
    const { es, id } = await opened();
    const heard = vi.fn();
    es.addEventListener('message', heard);
    es.close();
    expect(plugin.closeStream).toHaveBeenCalledWith({ id });
    expect(es.readyState).toBe(es.CLOSED);
    streamCb!({ id, kind: 'message', type: 'message', data: 'late' });
    expect(heard).not.toHaveBeenCalled();
  });

  it('with no plugin, the stream fails once and the next open uses the browser EventSource', async () => {
    available = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Fake = vi.fn(function (this: any, url: string) { this.url = url; });
    vi.stubGlobal('EventSource', Fake);
    const es = openEventStream(`${API}/api/sse/events`);
    await vi.waitFor(() => expect(es.readyState).toBe(2));
    openEventStream(`${API}/api/sse/events`);
    expect(Fake).toHaveBeenCalledTimes(1);
  });
});

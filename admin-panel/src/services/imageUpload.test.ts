// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A failed upload says why (owner, 2026-10-14: "we need to give the answer for
 * why it failed just as basic reason so we can fix that").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putToStorage } from './imageUpload';

const file = new File(['x'], 'card.png', { type: 'image/png' });

afterEach(() => { vi.unstubAllGlobals(); });

describe('putToStorage', () => {
  it('passes when the storage takes the file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(putToStorage('https://s3.example/put', file)).resolves.toBeUndefined();
  });

  it('sends the headers the server signed, the owner among them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signed = { 'Content-Type': 'image/png', 'x-amz-meta-userid': 'u1' };
    await putToStorage('https://s3.example/put', file, signed);
    expect(fetchMock.mock.calls[0][1].headers).toEqual(signed);
  });

  it('names CORS and S3_ENDPOINT when the storage cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(putToStorage('https://s3.example/put', file)).rejects.toThrow(/CORS[\s\S]*S3_ENDPOINT/);
  });

  it("turns the storage's error code into the setting to check", async () => {
    const xml = '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 403 })));
    await expect(putToStorage('https://s3.example/put', file)).rejects.toThrow(/HTTP 403, SignatureDoesNotMatch\): .*S3_SECRET_KEY/);
  });

  it("falls back to the storage's own message for a code it does not know", async () => {
    const xml = '<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 503 })));
    await expect(putToStorage('https://s3.example/put', file)).rejects.toThrow(/SlowDown\): Please reduce your request rate/);
  });
});

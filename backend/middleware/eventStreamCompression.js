// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * eventStreamCompression.js — gzip on the live event streams (`/api/sse/*`).
 *
 * ── Why the streams are compressed ─────────────────────────────────────────
 * One compressor per connection, flushed after every event, keeps its memory
 * of everything the stream already said: the second `cycle_phase` costs a few
 * bytes because the first one taught it the shape. MEASURED on a running
 * server (2026-10-10, 70 events over 3m20s of the public stream, boards idle):
 *
 *   | encoding                                   | bytes  | vs today |
 *   |--------------------------------------------|--------|----------|
 *   | JSON, uncompressed (what shipped)          | 25,956 |    —     |
 *   | MessagePack, base64 so SSE can carry it    | 27,019 |   +4%    |
 *   | gzip per event, no shared memory           | 13,635 |   −47%   |
 *   | gzip per connection, flushed per event     |  3,188 |   −88%   |
 *
 * So no binary format: SSE is text, MessagePack has to be base64'd to travel
 * on it, and that undoes its saving. Browsers and OkHttp (the native stream,
 * `SecureHttpPlugin`) both decode gzip themselves, so no client changes.
 *
 * ── Why gzip with a small window, never brotli ─────────────────────────────
 * The compressor lives as long as the connection, so its memory is per
 * PLAYER, not per request. `windowBits: 13, memLevel: 6` measured the same
 * 88% as zlib's defaults at roughly half the memory (~96 KB against ~164 KB a
 * stream); brotli measured 85% at ~240 KB. The streams therefore offer gzip
 * alone: a browser asking `br, gzip` is answered gzip.
 *
 * ── Every write flushes itself, here (S37) ─────────────────────────────────
 * zlib holds output until ~16 KB accumulates unless flushed, which once made
 * every stream silent in every browser. `flush: Z_SYNC_FLUSH` makes the
 * compressor push out each write as it is made, so no write site has to
 * remember anything. Never `res.flush()`: it is a FULL flush, which throws
 * away the shared memory — measured, it took the saving from 88% to 67%.
 * `eventStreamCompression.test.js` asks for a stream as a browser does and
 * fails if an event waits.
 */
import zlib from 'node:zlib';
import compression from 'compression';

/** True for a response that is a live event stream. */
export function isEventStream(res) {
    return String(res.getHeader('Content-Type') ?? '').includes('text/event-stream');
}

/** Offer the stream compressor gzip alone (see above). Only `/api/sse` requests pass here. */
function gzipOnly(req, _res, next) {
    const accepted = String(req.headers['accept-encoding'] ?? '');
    req.headers['accept-encoding'] = /\bgzip\b(?!\s*;\s*q=0(?:\.0*)?(?![.\d]))/i.test(accepted) ? 'gzip' : 'identity';
    next();
}

export const eventStreamCompression = [
    gzipOnly,
    compression({
        filter: (_req, res) => isEventStream(res),
        // A stream has no Content-Length; every event is worth compressing.
        threshold: 0,
        flush: zlib.constants.Z_SYNC_FLUSH,
        windowBits: 13,
        memLevel: 6,
    }),
];

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The request-body parsers, all of them (owner, 2026-10-24: refuse compressed
 * requests).
 *
 * A browser never compresses what it sends, and no panel does either, so a
 * body with a Content-Encoding (gzip, deflate, br) is refused 415 before a byte
 * is decoded. Nothing legitimate is lost, and the decompressor is where Node's
 * October 2026 Brotli flaw lived (CVE-2026-111497): a body that is never
 * unpacked cannot reach it. Every route parses through these two, so no route
 * can forget the option.
 */
import express from 'express';

export const NO_COMPRESSED_BODIES = Object.freeze({ inflate: false });

/** `express.json` that refuses a compressed body. */
export const jsonBody = (options = {}) => express.json({ ...options, ...NO_COMPRESSED_BODIES });

/** `express.raw` that refuses a compressed body. */
export const rawBody = (options = {}) => express.raw({ ...options, ...NO_COMPRESSED_BODIES });

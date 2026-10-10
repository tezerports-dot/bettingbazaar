// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player app's API layer: every endpoint a screen reads or writes, named
 * by what it does, one module per domain. Screens import from here and never
 * write a path or touch the transport (lint `no-restricted-imports`), so a
 * route that moves changes one line here and no component.
 *
 * Everything goes through `apiClient`: one origin (with failover), auth header,
 * GET retries, in-flight dedup, and the last-good fallback for display reads.
 * The sign-in, session and realtime surface is `getBackend()` (realBackend.ts).
 */
export * as payments from './payments';
export * as wallet from './wallet';
export * as player from './player';
export * as platform from './platform';
export * as games from './games';
export * as support from './support';
export * as notifications from './notifications';

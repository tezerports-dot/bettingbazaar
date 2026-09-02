// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Operational alerting (plan item 38, 2026-07-13). Sends a JSON POST to an
// ADMIN-CONFIGURED webhook (SystemConfig.alertWebhookUrl — editable in System
// Settings, no redeploy; env ALERT_WEBHOOK_URL is the bootstrap fallback) when
// a money-critical failure happens: ledger reconciliation failures, settlement
// errors. Payload shape is Slack-incoming-webhook compatible ({ text }) and
// also carries structured fields, so Slack, Discord (via /slack suffix),
// Mattermost, or any generic HTTP collector works. Fire-and-forget: an alert
// failure must NEVER break the money path that raised it. Per-key cooldown
// stops a crash-looping job from flooding the channel.
import mongoose from 'mongoose';
// Item 3 (2026-07-13): transient webhook failures (429/503, network blips) get
// a couple of JITTERED retries so a briefly-flaky collector still receives the
// page — full jitter so many instances alerting at once don't retry in lockstep.
import { fetchWithRetry } from '../utils/retry.js';

const COOLDOWN_MS = 10 * 60 * 1000; // same alert key at most once per 10 min
const lastSent = new Map();         // key -> ts (per-instance; duplicates across instances are acceptable for v1)

async function getWebhookUrl() {
  try {
    const cfg = await getSystemConfig();
    if (cfg?.alertWebhookUrl) return cfg.alertWebhookUrl;
  } catch { /* fall through to env */ }
  return process.env.ALERT_WEBHOOK_URL || '';
}

/**
 * sendAlert — notify a human. No-op when no webhook is configured.
 * @param {string} key     stable dedup key, e.g. 'ledger-reconcile-failure'
 * @param {string} title   one-line human summary
 * @param {object} details small JSON-safe context (ids, error message)
 */
export async function sendAlert(key, title, details = {}) {
  try {
    const now = Date.now();
    if ((lastSent.get(key) || 0) + COOLDOWN_MS > now) return; // cooldown
    const url = await getWebhookUrl();
    if (!url) return; // alerting not configured — silent no-op by design

    lastSent.set(key, now);
    const text = `🚨 [BettingBazaar] ${title}`;
    // 5s per-attempt timeout — never let a slow webhook hold anything open —
    // plus up to 2 jittered retries (full jitter, tight cap) for transient
    // failures. Bounded worst case ~ 3×5s + a few seconds of jitter; this runs
    // in a background/fire-and-forget context, never on a synchronous money path.
    await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, key, title, details, ts: new Date().toISOString() }),
    }, { timeoutMs: 5000, retries: 2, baseMs: 250, capMs: 2000, jitter: 'full' });
    try {
      const { alertsSent } = await import('./metrics.service.js');
      alertsSent.inc({ key });
    } catch { /* metrics optional */ }
  } catch (e) {
    // Alerting must never throw into the caller.
    console.error('[alerting] webhook send failed:', e.message);
  }
}

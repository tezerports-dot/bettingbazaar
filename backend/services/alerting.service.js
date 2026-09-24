// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Operational alerting (plan item 38, 2026-07-13). Sends a JSON POST to an
// ADMIN-CONFIGURED webhook (SystemConfig.alertWebhookUrl — editable in System
// Settings, no redeploy; env ALERT_WEBHOOK_URL is the bootstrap fallback) when
// a money-critical failure happens: ledger reconciliation failures, settlement
// errors. Payload shape is Slack-incoming-webhook compatible ({ text }) and
// also carries structured fields, so Slack, Discord (via /slack suffix),
// Mattermost, or any generic HTTP collector works. Fire-and-forget: an alert
// failure must NEVER break the money path that raised it. Per-key cooldown
// stops a crash-looping job from flooding the channel.
// Item 3 (2026-07-13): transient webhook failures (429/503, network blips) get
// a couple of JITTERED retries so a briefly-flaky collector still receives the
// page — full jitter so many instances alerting at once don't retry in lockstep.
import { fetchWithRetry } from '../utils/retry.js';
import { getSystemConfig } from '#db/repositories/config.js';

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

    // ── TWO SINKS, INDEPENDENT ──────────────────────────────────────────────
    // The webhook and the admin Telegram channel are not alternatives: an
    // operator may run one, the other, or both. The owner asked for the admin
    // bot to carry "security alerts to the admin channel" (2026-09-24), and an
    // operator who has that configured must not have to also stand up a Slack
    // endpoint to receive anything.
    //
    // The COOLDOWN is shared and checked once, above, so a crash-looping job
    // cannot flood one sink because the other was quiet. And it is claimed only
    // once at least one sink EXISTS — the version this replaced returned before
    // claiming it when no webhook was set, which is what made "no sinks" a
    // silent no-op rather than a silenced key.
    const text = `🚨 [BettingBazaar] ${title}`;
    const sinks = [];

    if (url) {
      // 5s per-attempt timeout — never let a slow webhook hold anything open —
      // plus up to 2 jittered retries (full jitter, tight cap) for transient
      // failures. Bounded worst case ~ 3×5s + a few seconds of jitter; this runs
      // in a background/fire-and-forget context, never on a synchronous money path.
      sinks.push(fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, key, title, details, ts: new Date().toISOString() }),
      }, { timeoutMs: 5000, retries: 2, baseMs: 250, capMs: 2000, jitter: 'full' }));
    }

    const telegram = await postToAdminChannel(text, details);
    if (telegram) sinks.push(telegram);

    if (!sinks.length) return; // alerting not configured — silent no-op by design
    lastSent.set(key, now);

    // `allSettled`, not `all`: a dead webhook must not stop the admin channel
    // receiving the page, and vice versa. Either failing is logged below by the
    // helper that raised it; neither reaches the caller.
    await Promise.allSettled(sinks);
    try {
      const { alertsSent } = await import('./metrics.service.js');
      alertsSent.inc({ key });
    } catch { /* metrics optional */ }
  } catch (e) {
    // Alerting must never throw into the caller.
    console.error('[alerting] webhook send failed:', e.message);
  }
}

/**
 * The admin Telegram channel, or null when there is not one.
 *
 * Returns a PROMISE to await (or null), rather than awaiting here, so the two
 * sinks run concurrently and a slow Bot API call does not delay the webhook.
 *
 * ── Why this cannot loop ──────────────────────────────────────────────────
 * Alerts are raised by, among other things, the channel gate — which is about
 * Telegram. A failure here is logged and swallowed; it never calls `sendAlert`.
 * The one path that could still recurse is an alert raised while resolving the
 * config, and there is none: `activeConfig` throws or returns null, and both
 * are handled without alerting.
 *
 * ── Why the STAFF audience specifically ──────────────────────────────────
 * This is the ADMIN channel. Posting an account-takeover alert into the player
 * channel would publish it to the entire user base, which is the worst possible
 * outcome of getting this line wrong — so the audience is a literal here rather
 * than anything a caller can influence.
 */
async function postToAdminChannel(text, details) {
  try {
    const { activeConfig, callApi } = await import('../domains/telegram/telegramClient.js');
    const cfg = await activeConfig('STAFF');
    if (!cfg?.botToken || !cfg?.channelId) return null;

    // Details as a fenced block: an alert is read on a phone, and a wall of
    // unformatted JSON in a chat is a wall nobody reads. `JSON.stringify` is
    // given a replacer-free two-space indent because these payloads are a
    // handful of ids, never a document.
    const body = Object.keys(details || {}).length
      ? `${text}\n<pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>`
      : text;

    return callApi(cfg.botToken, 'sendMessage', {
      chat_id: cfg.channelId,
      text: body,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).then((res) => {
      if (!res.ok) {
        // The commonest cause is the staff bot not being an administrator of
        // the staff channel. Nothing else on the platform would ever say so,
        // and the symptom is an alerting channel that is simply always empty.
        console.error(`[alerting] could not post to the admin channel: ${res.error}`);
      }
      return res;
    });
  } catch (e) {
    console.error('[alerting] admin channel sink failed:', e.message);
    return null;
  }
}

/**
 * `parse_mode: HTML` is set, so an `&` or a `<` inside a detail value would
 * make Telegram reject the whole message — which turns one alert into no alert,
 * silently, exactly when something has gone wrong. Escaped rather than sent as
 * plain text because the fenced block is what makes these readable on a phone.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

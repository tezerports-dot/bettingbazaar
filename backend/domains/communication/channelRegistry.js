// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Communication Platform (BBEPS Phase 012 — Customer Platforms tier).
//
// CHANNEL REGISTRY — every way the platform talks to a human is a CHANNEL
// adapter behind one interface (same pattern as the Funding Platform's
// provider registry; replaces channel-specific thinking, e.g. "Telegram").
//
// Adapter interface:
//   { code, label, active, send({ userId, type, title, message, actionUrl,
//     actionLabel, relatedId, relatedType, expiresAt }) → per-channel result }

import mongoose from 'mongoose';
import { networkClient } from '../../services/networkClient.js';

// ── IN_APP — live: persists a Notification document (the existing bell-icon
// inbox all three panels already read). The Notification model/collection is
// unchanged; this adapter is the single write path for it going forward.
const inApp = {
  code: 'IN_APP',
  label: 'In-app notification inbox',
  active: true,
  async send({ userId, type = 'INFO', title, message, actionUrl, actionLabel, relatedId, relatedType, expiresAt }) {
    const Notification = mongoose.model('Notification');
    const doc = await Notification.create({
      userId, type, title, message, actionUrl, actionLabel, relatedId, relatedType, expiresAt,
    });
    return { delivered: true, id: String(doc._id) };
  },
};

/*
 * REMOVED 2026-08-26 — the EMAIL channel and its SMTP adapter.
 *
 * It read `User.email`, and that field is gone. A player's identity is their
 * Aadhaar and the mobile behind their Telegram account; the bot never asks for
 * an email, so the address this adapter needed could not exist for anybody it
 * might have been asked to reach. Its only reachable answer was
 * "user has no email on file".
 *
 * That took `nodemailer` and the SMTP_* configuration with it. A dependency and
 * a set of production credentials carried for a code path that cannot fire is
 * cost and attack surface, not optionality.
 *
 * Reaching a player is Telegram or the in-app inbox. Do not add this back
 * without first adding a verified address to the identity model — and that is a
 * §1 decision, not an adapter.
 */

// ── Declared, inactive channels — activating one = implement send() against
// a real provider (SMS needs a gateway choice + credentials; PUSH
// additionally gates on FLAGS.PUSH_NOTIFICATIONS). No fake placeholders.
const inactive = (code, label) => ({
  code, label, active: false,
  async send() { throw new Error(`${label} channel is not configured.`); },
});

// ── SMS — generic HTTP gateway adapter (plan item 53, 2026-07-13),
// ACTIVATION-GATED on env exactly like EMAIL. No provider is hardcoded: any
// REST SMS gateway (MSG91, Kaleyra, Twilio-style, ...) works via config:
//   SMS_API_URL       required — endpoint; may contain {mobile} and {message}
//                     placeholders (URL-encoded) for GET-style gateways
//   SMS_API_METHOD    default POST
//   SMS_API_HEADERS   optional JSON, e.g. {"authkey":"...","Content-Type":"application/json"}
//   SMS_BODY_TEMPLATE optional JSON body template with {mobile}/{message}
//                     placeholders, e.g. {"to":"{mobile}","text":"{message}"}
// DLT template registration (India) is a legal prerequisite — owner action,
// documented in the deployment configuration. Unset SMS_API_URL = declared
// channel, inactive, exactly as before.
function smsConfigured() { return !!process.env.SMS_API_URL; }

const sms = {
  code: 'SMS',
  label: 'SMS',
  get active() { return smsConfigured(); },
  async send({ userId, title, message }) {
    if (!smsConfigured()) {
      return { delivered: false, reason: 'SMS gateway not configured (SMS_API_URL env).' };
    }
    const User = mongoose.model('User');
    const user = await User.findById(userId).select('mobile').lean();
    if (!user?.mobile) return { delivered: false, reason: 'User has no mobile on file.' };

    const text = [title, message].filter(Boolean).join(': ').slice(0, 480);
    const fill = (s) => s.replaceAll('{mobile}', encodeURIComponent(user.mobile))
                        .replaceAll('{message}', encodeURIComponent(text));

    const url    = fill(process.env.SMS_API_URL);
    const method = (process.env.SMS_API_METHOD || 'POST').toUpperCase();
    let headers  = { 'Content-Type': 'application/json' };
    try { if (process.env.SMS_API_HEADERS) headers = { ...headers, ...JSON.parse(process.env.SMS_API_HEADERS) }; }
    catch { /* malformed header JSON — proceed with defaults */ }

    let body;
    if (method !== 'GET' && process.env.SMS_BODY_TEMPLATE) {
      // Placeholders inside the JSON template are raw (not URL-encoded).
      body = process.env.SMS_BODY_TEMPLATE
        .replaceAll('{mobile}', user.mobile)
        .replaceAll('{message}', text.replaceAll('"', '\\"'));
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await networkClient.request(url, { method, headers, body, signal: ctrl.signal });
      return resp.ok
        ? { delivered: true, id: `sms-${Date.now()}` }
        : { delivered: false, reason: `Gateway HTTP ${resp.status}` };
    } catch (e) {
      return { delivered: false, reason: `Gateway error: ${e.message}` };
    } finally { clearTimeout(t); }
  },
};

const push  = inactive('PUSH', 'Web/App push');

const CHANNELS = Object.freeze({
  [inApp.code]: inApp,
  [sms.code]:   sms,
  [push.code]:  push,
});

export const DEFAULT_CHANNELS = Object.freeze(['IN_APP']);

export function getChannel(code) {
  const c = CHANNELS[code];
  if (!c) throw new Error(`Unknown communication channel '${code}'.`);
  return c;
}

export function listChannels() {
  return Object.values(CHANNELS).map(({ code, label, active }) => ({ code, label, active }));
}

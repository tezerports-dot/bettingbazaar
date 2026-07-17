// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

// ── EMAIL — real SMTP adapter (Phase E, 2026-07-10), ACTIVATION-GATED on
// environment credentials: set SMTP_HOST, SMTP_PORT (default 587),
// SMTP_USER, SMTP_PASS and SMTP_FROM in Railway and the channel reports
// active and delivers; unset, it stays a declared channel exactly as
// before. No provider is hardcoded — any SMTP service works (SES,
// Postmark, Brevo, ...). Users without an email on file are skipped with
// a reason (mobile is the identity; User.email is optional).
let _mailer = null;
function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}
async function getMailer() {
  if (_mailer) return _mailer;
  const { default: nodemailer } = await import('nodemailer');
  _mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return _mailer;
}

const email = {
  code: 'EMAIL',
  label: 'Email',
  get active() { return smtpConfigured(); },
  async send({ userId, title, message, actionUrl, actionLabel }) {
    if (!smtpConfigured()) {
      return { delivered: false, reason: 'SMTP not configured (SMTP_HOST/SMTP_FROM env).' };
    }
    const User = mongoose.model('User');
    const user = await User.findById(userId).select('email username').lean();
    if (!user?.email) {
      return { delivered: false, reason: 'User has no email on file.' };
    }
    const mailer = await getMailer();
    const cta = actionUrl
      ? `<p style="margin-top:16px"><a href="${actionUrl}" style="background:#D4AF37;color:#0B0E14;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${actionLabel || 'Open'}</a></p>`
      : '';
    const info = await mailer.sendMail({
      from: process.env.SMTP_FROM,
      to: user.email,
      subject: title || 'Notification',
      text: `${message || ''}${actionUrl ? `\n\n${actionLabel || 'Open'}: ${actionUrl}` : ''}`,
      html: `<div style="font-family:sans-serif;max-width:520px">
               <h2 style="margin:0 0 8px">${title || 'Notification'}</h2>
               <p style="color:#333;line-height:1.5">${message || ''}</p>${cta}
             </div>`,
    });
    return { delivered: true, id: info.messageId };
  },
};

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
  [email.code]: email,
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

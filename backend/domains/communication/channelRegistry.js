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

// ── Declared, inactive channels — activating one = implement send() against
// a real provider and flip active (EMAIL/SMS need provider credentials in
// admin config first; PUSH additionally gates on FLAGS.PUSH_NOTIFICATIONS).
const inactive = (code, label) => ({
  code, label, active: false,
  async send() { throw new Error(`${label} channel is not configured.`); },
});

const email = inactive('EMAIL', 'Email');
const sms   = inactive('SMS', 'SMS');
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

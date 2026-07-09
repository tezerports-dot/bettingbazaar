// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Communication Platform (BBEPS Phase 012 — Customer Platforms tier).
//
// THE notification engine facade: every user-facing message goes through
// notify(), which fans out to the requested channels. Callers never touch a
// channel (or the Notification model) directly — 04-GOVERNANCE.md §1.
//
// Per-channel failure isolation: one channel failing never blocks the
// others, and a fully-failed notification never throws into business flows
// (messaging is never allowed to break money movement or account actions).

import { getChannel, DEFAULT_CHANNELS, listChannels } from './channelRegistry.js';

/**
 * notify — send a message to a user across one or more channels.
 * Returns per-channel results; never throws.
 */
export async function notify({ userId, type, title, message, channels = DEFAULT_CHANNELS, ...rest }) {
  const results = [];
  if (!userId || !title || !message) {
    return [{ channel: 'NONE', delivered: false, error: 'notify() requires userId, title, message' }];
  }
  for (const code of channels) {
    try {
      const channel = getChannel(code);
      if (!channel.active) {
        results.push({ channel: code, delivered: false, error: 'channel inactive' });
        continue;
      }
      const res = await channel.send({ userId, type, title, message, ...rest });
      results.push({ channel: code, ...res });
    } catch (e) {
      results.push({ channel: code, delivered: false, error: e.message });
      console.warn(`[communication] ${code} send failed for user ${userId}:`, e.message);
    }
  }
  return results;
}

export { listChannels };

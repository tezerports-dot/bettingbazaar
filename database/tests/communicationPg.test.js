// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * In-app notification delivery, through the real communication service and the
 * real notifications table.
 *
 * ── Two bugs at the seam this pins ───────────────────────────────────────────
 * The communication domain speaks `type` (INFO | WARNING | ALERT | …); the
 * notifications repository speaks `kind`. The in-app channel is the translator,
 * and it used to pass `type` straight into `notify`, which never saw a `kind`,
 * defaulted it to 'INFO', and stored EVERY notification as INFO — a withdrawal
 * alert and a welcome note became indistinguishable in the inbox. It also read
 * `doc._id` for the delivery id, but the repository returns `id` (there is no
 * document-store `_id`), so the caller got the string "undefined".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '../client.js';
import { notify } from '../../backend/domains/communication/communication.service.js';
import { listNotifications } from '../repositories/engagement.js';
import { createUser } from '../repositories/users.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('in-app notification delivery', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const newUser = async () => {
    seq += 1;
    const id = `notif-${RUN}-${seq}`;
    await createUser({ userId: id, username: id, mobile: `7${RUN.replace(/\D/g, '2')}${String(seq).padStart(4, '0')}`.slice(0, 10) });
    return id;
  };

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('stores the notification TYPE as its kind, not flattened to INFO', async () => {
    const userId = await newUser();
    const [res] = await notify({ userId, type: 'ALERT', title: 'Withdrawal flagged', message: 'Review required', channels: ['IN_APP'] });
    expect(res.delivered, res.error).toBe(true);

    const inbox = await listNotifications(userId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type, 'the ALERT was stored as INFO').toBe('ALERT');
    expect(inbox[0].title).toBe('Withdrawal flagged');
  });

  it('returns a real delivery id, not the string "undefined"', async () => {
    const userId = await newUser();
    const [res] = await notify({ userId, type: 'INFO', title: 'Welcome', message: 'Hello', channels: ['IN_APP'] });
    expect(res.delivered).toBe(true);
    expect(res.id).toBeTruthy();
    expect(res.id).not.toBe('undefined');
    expect(Number.isNaN(Number(res.id)), `id ${res.id} is not numeric`).toBe(false);
  });

  it('keeps distinct types distinct in one inbox', async () => {
    // The whole point of a type: an inbox where a routine note and an alert are
    // told apart. When both were forced to INFO, they could not be.
    const userId = await newUser();
    await notify({ userId, type: 'INFO', title: 'Note', message: 'routine', channels: ['IN_APP'] });
    await notify({ userId, type: 'WARNING', title: 'Careful', message: 'heads up', channels: ['IN_APP'] });

    const kinds = (await listNotifications(userId)).map((n) => n.type).sort();
    expect(kinds).toEqual(['INFO', 'WARNING']);
  });

  it('refuses a notification missing the fields it needs', async () => {
    const results = await notify({ userId: '', title: '', message: '' });
    expect(results[0].delivered).toBe(false);
  });
});

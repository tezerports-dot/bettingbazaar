// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The ticket leaves the address bar at startup and is handed out once. */
import { describe, it, expect, beforeEach } from 'vitest';
import { captureTelegramTicket, takeTelegramTicket } from './telegramTicket';

beforeEach(() => { window.history.replaceState(null, '', '/merchant/'); takeTelegramTicket(); });

describe('the Telegram ticket', () => {
  it('is read from the fragment, removed from the address bar, and handed out once', () => {
    const t = 'aB3_-'.repeat(9);
    window.history.replaceState(null, '', `/merchant/#/tg/${t}`);
    captureTelegramTicket();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/merchant/');
    expect(takeTelegramTicket()).toBe(t);
    expect(takeTelegramTicket()).toBeNull();
  });

  it('a fragment that is not a ticket is removed too, and reported as not valid', () => {
    window.history.replaceState(null, '', '/merchant/#/tg/<script>');
    captureTelegramTicket();
    expect(window.location.hash).toBe('');
    expect(takeTelegramTicket()).toBe('');
  });

  it('leaves any other address alone', () => {
    window.history.replaceState(null, '', '/merchant/#section');
    captureTelegramTicket();
    expect(window.location.hash).toBe('#section');
    expect(takeTelegramTicket()).toBeNull();
  });
});

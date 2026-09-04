// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The sign-in door.
 *
 * ── The property this protects ──────────────────────────────────────────────
 * The bot username is FETCHED, never hard-coded, and that is the whole point of
 * the component. Telegram suspends gambling bots; when it happens an operator
 * promotes a replacement from the admin panel and this button has to point at
 * the new one within the minute — not after rebuilding and redeploying three
 * applications, during an outage in which nobody can sign up.
 *
 * A hard-coded username would pass every happy-path test ever written and fail
 * only on the day it mattered. So what is asserted here is that the link is
 * built from the response, and that a referral code survives into it: the
 * referrer earned that signup and the code is the only thing that credits them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let storedRef: string | null = null;
vi.mock('../../services/referralCapture', () => ({
  storedReferralCode: () => storedRef,
}));
vi.mock('../../services/apiUrl', () => ({ apiUrl: (p: string) => `http://test${p}` }));

const { default: AuthModal } = await import('./AuthModal');

const CONFIG = {
  success: true,
  botUsername: 'bazaar_signin_bot',
  recoveryBotUsername: 'bazaar_recovery_bot',
  channelInviteLink: 'https://t.me/+abc',
};

/** The one link that opens the bot, found by its destination rather than text. */
const botLink = () =>
  Array.from(document.querySelectorAll('a')).find((a) => a.href.includes('t.me/bazaar_signin_bot'));

describe('AuthModal', () => {
  beforeEach(() => {
    storedRef = null;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => CONFIG }));
  });

  it('builds the bot link from the FETCHED username, not a constant', async () => {
    render(<AuthModal />);
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toBe('https://t.me/bazaar_signin_bot');
  });

  it('follows a bot swap without a redeploy', async () => {
    // The same component, a different answer from the server, a different
    // destination. This is the property the whole design exists for.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ...CONFIG, botUsername: 'bazaar_standby_bot' }),
    }));
    render(<AuthModal />);
    await waitFor(() => {
      const link = Array.from(document.querySelectorAll('a')).find((a) => a.href.includes('t.me/'));
      expect(link!.href).toContain('bazaar_standby_bot');
    });
  });

  it('carries a stored referral code into the deep link', async () => {
    // The referrer earned this signup, and the code is the only thing that
    // credits them. Dropping it loses a payout silently.
    storedRef = 'REF123';
    render(<AuthModal />);
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toBe('https://t.me/bazaar_signin_bot?start=REF123');
  });

  it('URL-encodes a referral code rather than pasting it raw', async () => {
    storedRef = 'a b&c';
    render(<AuthModal />);
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toContain('start=a%20b%26c');
  });

  it('opens the bot in a new tab, safely', async () => {
    render(<AuthModal />);
    await waitFor(() => expect(botLink()).toBeTruthy());
    // `noopener` matters on a target=_blank link: without it the opened page
    // can navigate this one through window.opener.
    expect(botLink()!.target).toBe('_blank');
    expect(botLink()!.rel).toContain('noopener');
  });

  it('says sign-in is unavailable when the server refuses, rather than a dead button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ success: false, message: 'No bot is configured.' }),
    }));
    render(<AuthModal />);
    expect(await screen.findByText('No bot is configured.')).toBeInTheDocument();
    // And no link, because there is nowhere to send them.
    expect(botLink()).toBeUndefined();
  });

  it('names the network as the problem when the request fails', async () => {
    // Distinct from the refusal above: one is the platform's fault and one is
    // the connection's, and the player can act on the second.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<AuthModal />);
    expect(await screen.findByText(/Could not reach the server/i)).toBeInTheDocument();
  });

  it('offers no password form — there is nothing to type', async () => {
    // Signup and login both happen inside the bot. A form here would be a
    // second way in, with none of the phone or Aadhaar proof behind it.
    const { container } = render(<AuthModal />);
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('shows a close control only when it can be closed', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<AuthModal onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    // Mounted as a blocking door with no handler: offering a close button that
    // does nothing is worse than offering none.
    render(<AuthModal />);
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });
});

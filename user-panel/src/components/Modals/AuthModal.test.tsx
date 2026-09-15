// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 *
 * ── And, since 2026-09-08, the form ─────────────────────────────────────────
 * A returning player signs in HERE — mobile, then the six digits the bot DMs —
 * without opening Telegram at all. The bot link stays for first-time signup,
 * which cannot move: the contact share is what proves the number, and a bot
 * cannot message somebody who has never started a chat with it.
 *
 * The assertions below are mostly about what the screen does NOT say. The
 * server answers a registered number, an unregistered one and a blocked one
 * identically, and a screen that helpfully distinguishes them hands back the
 * account-enumeration the endpoint was written to refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let storedRef: string | null = null;
vi.mock('../../services/referralCapture', () => ({
  storedReferralCode: () => storedRef,
}));
vi.mock('../../services/apiUrl', () => ({ apiUrl: (p: string) => `http://test${p}` }));

const auth = vi.hoisted(() => ({ request: vi.fn(), signIn: vi.fn() }));
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ requestLoginCode: auth.request, signInWithCode: auth.signIn }),
}));

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

/**
 * Render on the SIGN UP door, where the bot link lives.
 *
 * It used to be a footnote under the sign-in form, shown to everybody. It is
 * its own tab now: as a footnote it asked every returning player to read a
 * paragraph to learn they were already in the right place, and every new one to
 * read a form they could not use.
 */
const renderSignup = (props = {}) => {
  const r = render(<AuthModal initialMode="register" {...props} />);
  return r;
};

describe('AuthModal', () => {
  beforeEach(() => {
    storedRef = null;
    auth.request.mockReset().mockResolvedValue(undefined);
    auth.signIn.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => CONFIG }));
  });

  it('builds the bot link from the FETCHED username, not a constant', async () => {
    renderSignup();
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toBe('https://t.me/bazaar_signin_bot');
  });

  it('follows a bot swap without a redeploy', async () => {
    // The same component, a different answer from the server, a different
    // destination. This is the property the whole design exists for.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ...CONFIG, botUsername: 'bazaar_standby_bot' }),
    }));
    renderSignup();
    await waitFor(() => {
      const link = Array.from(document.querySelectorAll('a')).find((a) => a.href.includes('t.me/'));
      expect(link!.href).toContain('bazaar_standby_bot');
    });
  });

  it('carries a stored referral code into the deep link', async () => {
    // The referrer earned this signup, and the code is the only thing that
    // credits them. Dropping it loses a payout silently.
    storedRef = 'REF123';
    renderSignup();
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toBe('https://t.me/bazaar_signin_bot?start=REF123');
  });

  it('URL-encodes a referral code rather than pasting it raw', async () => {
    storedRef = 'a b&c';
    renderSignup();
    await waitFor(() => expect(botLink()).toBeTruthy());
    expect(botLink()!.href).toContain('start=a%20b%26c');
  });

  it('opens the bot in a new tab, safely', async () => {
    renderSignup();
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

  it('offers no password field — the code is the only thing typed', async () => {
    // There is a form now, but nothing on it is a password. A password here
    // would be a second way in with none of the phone or Aadhaar proof behind
    // it, and nothing on the server would accept one.
    const { container } = render(<AuthModal />);
    await screen.findByLabelText(/mobile number/i);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  describe('signing in with a code', () => {
    const typeMobile = async (n: string) => {
      await userEvent.type(screen.getByLabelText(/mobile number/i), n);
    };

    it('asks for the code only once a full number is typed', async () => {
      render(<AuthModal />);
      const send = screen.getByRole('button', { name: /send code/i });
      expect(send).toBeDisabled();

      await typeMobile('98765432');   // eight digits
      expect(send).toBeDisabled();
      await typeMobile('10');         // ten
      expect(send).toBeEnabled();
    });

    it('sends the number, then asks for the six digits', async () => {
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      await waitFor(() => expect(auth.request).toHaveBeenCalledWith('9876543210'));
      expect(await screen.findByLabelText(/code from telegram/i)).toBeInTheDocument();
    });

    it('promises nothing about whether the number is registered', async () => {
      // The server answers registered, unregistered and blocked identically.
      // A screen that says "we sent it" is a way to test whether a given person
      // gambles here, whatever the server does.
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      const notice = await screen.findByRole('status');
      expect(notice).toHaveTextContent(/if that number is registered/i);
      expect(notice).not.toHaveTextContent(/we have sent you|account found|welcome back/i);
    });

    it('signs in with the code and closes', async () => {
      const onClose = vi.fn();
      render(<AuthModal onClose={onClose} />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      await userEvent.type(await screen.findByLabelText(/code from telegram/i), '123456');
      await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

      await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('9876543210', '123456'));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('will not submit fewer than six digits', async () => {
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      await userEvent.type(await screen.findByLabelText(/code from telegram/i), '12345');
      expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled();
      expect(auth.signIn).not.toHaveBeenCalled();
    });

    it('reports a bad code and clears the box', async () => {
      auth.signIn.mockRejectedValue(new Error('That code is not valid. Request a new one and try again.'));
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      const box = await screen.findByLabelText(/code from telegram/i);
      await userEvent.type(box, '000000');
      await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
      await waitFor(() => expect(box).toHaveValue(''));
    });

    it('counts down instead of blaming the code when the server paces it', async () => {
      // A pace refusal is not a wrong code. Saying "that code is not valid"
      // sends the player to request another one — which the pace also refuses —
      // and now the screen looks broken rather than throttled.
      auth.signIn.mockRejectedValue({
        status: 429,
        data: { code: 'LOGIN_PACED', retryAfter: 9, retryAt: new Date(Date.now() + 9000).toISOString() },
      });
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));

      await userEvent.type(await screen.findByLabelText(/code from telegram/i), '000000');
      await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

      expect(await screen.findByRole('button', { name: /try again in \d+s/i })).toBeDisabled();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('lets the player go back and correct the number', async () => {
      render(<AuthModal />);
      await typeMobile('9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));
      await screen.findByLabelText(/code from telegram/i);

      await userEvent.click(screen.getByRole('button', { name: /change number/i }));
      expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
    });

    it('offers a Sign up door, and it is the bot', async () => {
      // The form is for returning players. A first-timer has no linked Telegram
      // account for a code to be sent to, so the bot path cannot go away — it
      // is the other tab.
      render(<AuthModal />);
      // Not on the login door.
      await screen.findByLabelText(/mobile number/i);
      expect(botLink()).toBeUndefined();

      await userEvent.click(screen.getByRole('tab', { name: /sign up/i }));
      await waitFor(() => expect(botLink()).toBeTruthy());
      // And the form is gone, so there is nothing to fill in that cannot work.
      expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
    });

    it('comes back to the login door from sign up', async () => {
      render(<AuthModal />);
      await userEvent.click(screen.getByRole('tab', { name: /sign up/i }));
      await userEvent.click(screen.getByRole('button', { name: /log in instead/i }));
      expect(await screen.findByLabelText(/mobile number/i)).toBeInTheDocument();
    });

    it('offers recovery when the code never arrives', async () => {
      // Without this the code step was a dead end: the screen said a code had
      // been sent and offered nothing else. The usual reason is that the
      // Telegram account they signed up with is gone, and recovery is the only
      // route back — it needs this same mobile plus the Aadhaar behind it.
      render(<AuthModal />);
      await userEvent.type(await screen.findByLabelText(/mobile number/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /send code/i }));
      await screen.findByLabelText(/code from telegram/i);

      const link = await screen.findByRole('link', { name: /recover your account/i });
      expect(link).toHaveAttribute('href', 'https://t.me/bazaar_recovery_bot');
    });

    it('takes ten digits and fixes the country code at +91', async () => {
      // Every player is Indian, so +91 is shown rather than typed. A country
      // code in the box is the one way this field produces a number the lookup
      // will not match — and that failure is silent: the screen says a code was
      // sent and none was.
      render(<AuthModal />);
      const box = await screen.findByLabelText(/mobile number/i);
      await userEvent.type(box, '+919876543210');
      expect(box).toHaveValue('9198765432');   // digits only, capped at ten
      expect(screen.getByText('+91')).toBeInTheDocument();
    });
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

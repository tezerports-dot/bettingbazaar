// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The signup form and the login form.
 *
 * ── What this replaced ─────────────────────────────────────────────────────
 * Nineteen tests about a six-digit code the bot DMed, and a Sign-up tab whose
 * only control was a deep link into that bot. Both are gone (owner decision,
 * 2026-09-23) and the tests had to go with them: a suite pinning a design
 * decision has to be rewritten by the change that reverses the decision, or it
 * fails as a false alarm and gets deleted by somebody in a hurry — which loses
 * the properties that DID survive.
 *
 * Three survived and are asserted below, because each one is a real defect if
 * it regresses:
 *
 *   · the login form says NOTHING about whether a number is registered;
 *   · a refusal is shown VERBATIM, because the server names the field;
 *   · a 2FA challenge is a second STEP, never an error.
 *
 * And two are new, both from the owner's spec: the invite code is pre-filled
 * and NON-EDITABLE when the player arrived by a referral link, and the screen
 * confirms whose code it is — a field nobody can change had better be right.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const register = vi.fn();
const signIn = vi.fn();
const signInWithSecondFactor = vi.fn();
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ register, signIn, signInWithSecondFactor }),
}));

const checkInvite = vi.fn();
vi.mock('../../services/backend.service', () => ({
  getBackend: () => ({ checkInvite }),
}));

let stored: string | null = null;
vi.mock('../../services/referralCapture', () => ({
  storedReferralCode: () => stored,
}));

const { default: AuthModal } = await import('./AuthModal');

const onClose = vi.fn();
const open = (mode: 'login' | 'register' = 'login') =>
  render(<AuthModal onClose={onClose} initialMode={mode} />);

const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;

async function fillSignup(over: Partial<Record<string, string>> = {}) {
  await userEvent.type(field(/aadhaar number/i), over.aadhaar ?? '123456789012');
  await userEvent.type(field(/aadhaar-linked mobile/i), over.mobile ?? '9876543210');
  await userEvent.type(field(/^password$/i), over.password ?? 'a-long-enough-phrase');
  await userEvent.type(field(/confirm password/i), over.confirm ?? 'a-long-enough-phrase');
}

beforeEach(() => {
  stored = null;
  onClose.mockReset();
  register.mockReset().mockResolvedValue(undefined);
  signIn.mockReset().mockResolvedValue({});
  signInWithSecondFactor.mockReset().mockResolvedValue(undefined);
  checkInvite.mockReset().mockResolvedValue({ valid: true, invitedBy: 'player3210' });
});

describe('the signup form', () => {
  it('addresses every field by the name printed next to it', async () => {
    // §32 S24: 124 labels on this platform sat next to the control they named
    // with no htmlFor and no id, so the text was on screen and the control was
    // not ADDRESSABLE by it. Untestable and unusable have one cause, and this
    // whole file would be impossible without the fix.
    open('register');
    for (const name of [/aadhaar number/i, /aadhaar-linked mobile/i, /^password$/i,
                        /confirm password/i, /invite code/i]) {
      expect(field(name)).toBeTruthy();
    }
  });

  it('submits what the player typed, and closes', async () => {
    open('register');
    await fillSignup();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(register).toHaveBeenCalledWith({
      aadhaar: '123456789012', mobile: '9876543210',
      password: 'a-long-enough-phrase', confirmPassword: 'a-long-enough-phrase',
      referralCode: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps every character typed into every field', async () => {
    // §32 S23. `FakeWinnersManager` declared its field component inside itself,
    // so React remounted it on every keystroke and typing "Rahul" left "R". A
    // test that types ONE character passes, which is why this types many into
    // every box and reads them all back.
    open('register');
    await fillSignup({ aadhaar: '111122223333', mobile: '9000011111' });
    expect(field(/aadhaar number/i).value).toBe('111122223333');
    expect(field(/aadhaar-linked mobile/i).value).toBe('9000011111');
    expect(field(/^password$/i).value).toBe('a-long-enough-phrase');
  });

  it('holds the button until the form can possibly succeed', async () => {
    open('register');
    const button = screen.getByRole('button', { name: /create account/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await fillSignup();
    expect(button.disabled).toBe(false);
  });

  it('keeps non-digits out of the Aadhaar and mobile boxes', async () => {
    open('register');
    await userEvent.type(field(/aadhaar number/i), '1234-5678 9012');
    expect(field(/aadhaar number/i).value).toBe('123456789012');
  });

  it('strips a country code the player typed as well as the one on screen', async () => {
    // FOUND BY TYPING IT. `+91 98765 43210` used to land as `9198765432`: ten
    // digits, starting with a 9, indistinguishable from a real number to every
    // check on both sides. The account would be created on a number that is
    // not theirs, the Telegram contact share would then match nothing forever,
    // and `users.mobile` is never mutable — so the player sits at the
    // verification gate permanently and support cannot fix it either.
    //
    // Both boxes, because the login box has the same "+91" printed beside it
    // and the same person types into it.
    for (const [screenName, label] of [
      ['register', /aadhaar-linked mobile/i] as const,
      ['login', /mobile number/i] as const,
    ]) {
      const view = render(<AuthModal onClose={onClose} initialMode={screenName as 'login' | 'register'} />);
      await userEvent.type(field(label), '+91 98765 43210');
      expect(field(label).value, screenName).toBe('9876543210');
      view.unmount();
    }
  });

  it('strips a leading zero, the other way an Indian number gets written', async () => {
    open('register');
    await userEvent.type(field(/aadhaar-linked mobile/i), '09876543210');
    expect(field(/aadhaar-linked mobile/i).value).toBe('9876543210');
  });

  it('shows the server refusal VERBATIM, because it names the field', async () => {
    register.mockRejectedValue(new Error('Enter the 10-digit mobile number linked to that Aadhaar, without +91.'));
    open('register');
    await fillSignup();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent', 'Enter the 10-digit mobile number linked to that Aadhaar, without +91.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells them what happens next, before they submit', async () => {
    // Somebody who does not know a Telegram step is coming will read the gate
    // that appears a second later as an error.
    open('register');
    expect(screen.getByText(/open our telegram bot from this same mobile number/i)).toBeTruthy();
  });
});

describe('the invite code, when the player arrived by a referral link', () => {
  it('pre-fills it and does NOT let them edit it', async () => {
    // Owner's requirement. A code somebody retypes is a code that can be
    // mistyped, and a mistyped code silently costs the referrer their earning —
    // the worst possible shape for an attribution bug.
    stored = 'ALICE123';
    open('register');
    const box = field(/invite code/i);
    expect(box.value).toBe('ALICE123');
    expect(box.disabled).toBe(true);
  });

  it('confirms whose code it is', async () => {
    stored = 'ALICE123';
    open('register');
    expect(await screen.findByText(/invited by/i)).toBeTruthy();
    expect(screen.getByText('player3210')).toBeTruthy();
    expect(checkInvite).toHaveBeenCalledWith('ALICE123');
  });

  it('offers a way out when the link carried a dead code', async () => {
    // Without this the player is stuck: a field they cannot edit, holding a
    // code the server will refuse by name, with no control that changes it.
    // §32 S22 in reverse — a state with no control at all.
    checkInvite.mockResolvedValue({ valid: false });
    stored = 'DEADCODE';
    open('register');
    await userEvent.click(await screen.findByRole('button', { name: /clear it/i }));
    expect(field(/invite code/i).value).toBe('');
  });

  it('leaves the box EDITABLE for somebody who arrived on their own', async () => {
    open('register');
    const box = field(/invite code/i);
    expect(box.disabled).toBe(false);
    await userEvent.type(box, 'friend9');
    // Upper-cased on the way in: codes are generated upper case and looked up
    // by exact match, so a lower-case entry matches nothing.
    expect(box.value).toBe('FRIEND9');
  });
});

describe('the login form', () => {
  it('signs in and closes', async () => {
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'a-long-enough-phrase');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));
    expect(signIn).toHaveBeenCalledWith('9876543210', 'a-long-enough-phrase');
    expect(onClose).toHaveBeenCalled();
  });

  it('promises nothing about whether the number is registered', async () => {
    // A login form that says "no such account" is a way to test whether a given
    // person gambles here. The server answers a wrong password and an unknown
    // number identically; this screen must not add a distinction of its own.
    signIn.mockRejectedValue(new Error('Invalid credentials'));
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid credentials');
    expect(alert.textContent).not.toMatch(/not registered|no account|unknown/i);
  });

  it('treats a 2FA challenge as a STEP, not an error', async () => {
    // `success: false` comes back with the challenge, deliberately. A screen
    // that read that as a failure would show "Invalid credentials" to somebody
    // whose password was correct.
    signIn.mockResolvedValue({ twoFactorRequired: true, challengeToken: 'chal-1' });
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'a-long-enough-phrase');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(field(/authenticator code/i)).toBeTruthy();
  });

  it('redeems the challenge with the six digits', async () => {
    signIn.mockResolvedValue({ twoFactorRequired: true, challengeToken: 'chal-1' });
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'a-long-enough-phrase');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));

    await userEvent.type(field(/authenticator code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));
    expect(signInWithSecondFactor).toHaveBeenCalledWith('chal-1', '123456');
    expect(onClose).toHaveBeenCalled();
  });

  it('will not submit fewer than six digits', async () => {
    signIn.mockResolvedValue({ twoFactorRequired: true, challengeToken: 'chal-1' });
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'a-long-enough-phrase');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));

    await userEvent.type(field(/authenticator code/i), '123');
    expect((screen.getByRole('button', { name: /verify/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(signInWithSecondFactor).not.toHaveBeenCalled();
  });

  it('counts down instead of blaming the password when the server PACES it', async () => {
    // `/login` is paced at one attempt per ten seconds, keyed on the MOBILE, so
    // a player who mistypes and immediately retries will hit it. Without this,
    // the refusal sits beside a button that still looks pressable: they press
    // it, extend the window, and the form reads as broken rather than
    // throttled. The paced fields have to survive the throw for this to work.
    signIn.mockRejectedValue(Object.assign(new Error('Too many attempts. Try again in 10 seconds.'), {
      code: 'LOGIN_PACED', retryAfter: 10,
    }));
    open('login');
    await userEvent.type(field(/mobile number/i), '9876543210');
    await userEvent.type(field(/^password$/i), 'a-long-enough-phrase');
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));

    const button = await screen.findByRole('button', { name: /try again in \d+s/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // And it must NOT be reported as a bad password.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers a way to the signup form, and back', async () => {
    open('login');
    await userEvent.click(screen.getByRole('button', { name: /create an account/i }));
    expect(field(/aadhaar number/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /log in/i }));
    expect(field(/mobile number/i)).toBeTruthy();
  });

  it('offers NO sign-in code and NO bot link — the bot cannot sign anybody in', async () => {
    // The security half of the 2026-09-23 change, asserted from the screen: a
    // compromised or suspended bot must not be an account takeover, and with a
    // fleet of hundreds that stopped being hypothetical.
    open('login');
    expect(screen.queryByText(/send code|sign-in code|telegram/i)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

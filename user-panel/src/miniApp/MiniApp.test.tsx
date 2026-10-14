// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App shows what the server says the page was opened for, sends the
 * SIGNED contact string (never `responseUnsafe`), and shows refusals verbatim.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { context, approve, continueToSite, passwordReset } = vi.hoisted(() => ({
  context: vi.fn(), approve: vi.fn(), continueToSite: vi.fn(), passwordReset: vi.fn(),
}));
vi.mock('./miniAppApi', async (orig) => ({
  ...(await orig<typeof import('./miniAppApi')>()),
  miniApi: { context, approve, continueToSite, passwordReset },
}));

import MiniApp from './MiniApp';

const SIGNED = 'contact=%7B%7D&auth_date=1&hash=abc';
const app = (shared = true) => ({
  initData: 'query_id=1&hash=x', ready: vi.fn(), expand: vi.fn(), close: vi.fn(), openLink: vi.fn(),
  requestContact: vi.fn((cb) => cb(shared, shared ? { response: SIGNED, responseUnsafe: { contact: {} } } : undefined)),
});
const ctx = (start: object, accounts: object[] = []) => ({
  telegramUser: { id: '1', username: 'asha', firstName: 'Asha' }, start, accounts,
});

beforeEach(() => {
  [context, approve, continueToSite, passwordReset].forEach((f) => f.mockReset());
});

describe('the Mini App', () => {
  it('refuses to work outside Telegram', () => {
    render(<MiniApp app={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/inside the telegram app/i);
  });

  it('verifies with the SIGNED contact string', async () => {
    context.mockResolvedValue(ctx({ kind: 'VERIFY', panel: 'PLAYER', needsContact: true, state: 'PENDING', mobileHint: '••••••3210' }));
    approve.mockResolvedValue({ kind: 'VERIFY', panel: 'PLAYER', approved: true, message: 'Done. Go back to the website or app.' });
    const a = app();
    render(<MiniApp app={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /share contact and approve/i }));
    expect(await screen.findByText(/go back to the website/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(a.initData, 'approve', SIGNED);
  });

  it('shows a mismatched contact as the server words it', async () => {
    context.mockResolvedValue(ctx({ kind: 'VERIFY', panel: 'PLAYER', needsContact: true, state: 'PENDING' }));
    approve.mockRejectedValue(new Error('This Telegram account is on another number.'));
    render(<MiniApp app={app()} />);
    fireEvent.click(await screen.findByRole('button', { name: /share contact and approve/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('This Telegram account is on another number.');
  });

  it('sends nothing when the contact share is declined', async () => {
    context.mockResolvedValue(ctx({ kind: 'VERIFY', panel: 'PLAYER', needsContact: true, state: 'PENDING' }));
    render(<MiniApp app={app(false)} />);
    fireEvent.click(await screen.findByRole('button', { name: /share contact and approve/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/share your contact/i);
    expect(approve).not.toHaveBeenCalled();
  });

  it('lets a sign-in be denied, with no contact', async () => {
    context.mockResolvedValue(ctx({ kind: 'LOGIN', panel: 'MERCHANT', needsContact: false, state: 'PENDING',
      request: { at: '2026-10-08T05:00:00Z', ip: '203.0.113.9', device: 'Chrome' } }));
    approve.mockResolvedValue({ kind: 'LOGIN', panel: 'MERCHANT', approved: false, message: 'Refused. Nobody was signed in.' });
    render(<MiniApp app={app()} />);
    expect(await screen.findByText(/203\.0\.113\.9/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(await screen.findByText(/nobody was signed in/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(expect.any(String), 'deny', null);
  });

  it('says an expired request is expired, and offers no button', async () => {
    context.mockResolvedValue(ctx({ kind: 'LOGIN', panel: 'PLAYER', needsContact: false, state: 'EXPIRED' }));
    render(<MiniApp app={app()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/expired/i);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('sets the new password in the Mini App for a merchant, at the merchant floor, with the signed contact', async () => {
    context.mockResolvedValue(ctx({ kind: 'RESET', panel: 'MERCHANT', needsContact: true }));
    passwordReset.mockResolvedValue({ panel: 'MERCHANT', changed: true, message: 'Your password has been changed. Sign in with the new password now.' });
    const a = app();
    render(<MiniApp app={a} />);
    const box = await screen.findByLabelText(/^new password$/i);
    const go = () => screen.getByRole('button', { name: /share contact and reset/i }) as HTMLButtonElement;
    // Eleven characters: a player's password, not a merchant's.
    fireEvent.change(box, { target: { value: 'Eleven-char' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'Eleven-char' } });
    expect(screen.getByText(/at least 12 characters/i)).toBeTruthy();
    expect(go().disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Twelve-chars' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'Twelve-chars' } });
    fireEvent.click(go());
    expect(await screen.findByText(/sign in with the new password/i)).toBeTruthy();
    expect(passwordReset).toHaveBeenCalledWith(a.initData, SIGNED, { password: 'Twelve-chars', confirmPassword: 'Twelve-chars' });
    expect(screen.queryByRole('button', { name: /choose a new password/i })).toBeNull();
  });

  it('does not open the contact prompt when the two passwords differ', async () => {
    context.mockResolvedValue(ctx({ kind: 'RESET', panel: 'PLAYER', needsContact: true }));
    const a = app();
    render(<MiniApp app={a} />);
    fireEvent.change(await screen.findByLabelText(/^new password$/i), { target: { value: 'first-password' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'second-password' } });
    fireEvent.click(screen.getByRole('button', { name: /share contact and reset/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/i);
    expect(a.requestContact).not.toHaveBeenCalled();
    expect(passwordReset).not.toHaveBeenCalled();
  });

  it("shows the server's refusal of the password as it is worded", async () => {
    context.mockResolvedValue(ctx({ kind: 'RESET', panel: 'MERCHANT', needsContact: true }));
    passwordReset.mockRejectedValue(new Error('That password is one repeated or sequential run of characters.'));
    render(<MiniApp app={app()} />);
    fireEvent.change(await screen.findByLabelText(/^new password$/i), { target: { value: 'aaaaaaaaaaaa' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'aaaaaaaaaaaa' } });
    fireEvent.click(screen.getByRole('button', { name: /share contact and reset/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('That password is one repeated or sequential run of characters.');
  });
});

describe('the Verify screen (Continue with Telegram)', () => {
  const signIn = (extra: object = {}) => ctx({
    kind: 'TELEGRAM_LOGIN', panel: 'PLAYER', needsContact: false, state: 'PENDING',
    destination: 'bettingbazaar.com', account: { panel: 'PLAYER', isNew: false, mobileHint: '••••••3210' },
    request: { at: '2026-10-13T05:00:00Z', ip: '203.0.113.9', device: 'Chrome on Windows' }, ...extra,
  });

  it('names where Verify sends them and whose account it enters, and approves only on a press', async () => {
    context.mockResolvedValue(signIn({ delivery: 'HANDOFF', choices: null }));
    approve.mockResolvedValue({ approved: true, message: 'Opening…', redirectUrl: 'https://bettingbazaar.com/#/tg/abc' });
    const a = app();
    render(<MiniApp app={a} />);
    expect(await screen.findByText(/you will be sent to bettingbazaar\.com/i)).toBeTruthy();
    expect(screen.getByTestId('verify-account').textContent).toMatch(/3210/);
    expect(screen.getByText(/203\.0\.113\.9/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByText(/opening bettingbazaar\.com/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(a.initData, 'approve', null, null);
    expect(a.openLink).toHaveBeenCalledWith('https://bettingbazaar.com/#/tg/abc');
  });

  it('a MATCH needs one of the three numbers chosen, and sends the one chosen', async () => {
    context.mockResolvedValue(signIn({ delivery: 'MATCH', choices: [31, 47, 82], strikesLeft: 3 }));
    approve.mockResolvedValue({ approved: true, message: 'Done. Go back to the website or app — it will continue on its own.', redirectUrl: null });
    const a = app();
    render(<MiniApp app={a} />);
    const verify = await screen.findByRole('button', { name: /^verify$/i }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '47' }));
    expect(screen.getByRole('button', { name: '47' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(verify);
    expect(await screen.findByText(/go back to the website/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(a.initData, 'approve', null, 47);
    expect(a.openLink).not.toHaveBeenCalled();
  });

  it('shows a wrong number as the server words it', async () => {
    context.mockResolvedValue(signIn({ delivery: 'MATCH', choices: [31, 47, 82], strikesLeft: 3 }));
    approve.mockRejectedValue(new Error('That is not the number on the screen you are signing in on. 2 tries left.'));
    render(<MiniApp app={app()} />);
    fireEvent.click(await screen.findByRole('button', { name: '31' }));
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/2 tries left/);
  });

  it('a new account shares the SIGNED contact at Verify, once', async () => {
    context.mockResolvedValue(signIn({ delivery: 'HANDOFF', needsContact: true, account: { panel: 'PLAYER', isNew: true, mobileHint: '' } }));
    approve.mockResolvedValue({ approved: true, message: 'Opening…', redirectUrl: 'https://bettingbazaar.com/#/tg/abc' });
    const a = app();
    render(<MiniApp app={a} />);
    expect((await screen.findByTestId('verify-account')).textContent).toMatch(/creates your player account/i);
    fireEvent.click(screen.getByRole('button', { name: /share contact and verify/i }));
    expect(await screen.findByText(/opening/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(a.initData, 'approve', SIGNED, null);
  });

  it('Deny refuses the sign-in', async () => {
    context.mockResolvedValue(signIn({ delivery: 'MATCH', choices: [31, 47, 82] }));
    approve.mockResolvedValue({ approved: false, message: 'Refused. Nobody was signed in.' });
    render(<MiniApp app={app()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^deny$/i }));
    expect(await screen.findByText(/nobody was signed in/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(expect.any(String), 'deny', null);
  });

  it('opened from the bot itself, Verify continues to the site', async () => {
    context.mockResolvedValue(ctx({ kind: 'CONTINUE', panel: 'PLAYER', needsContact: false,
      destination: 'bettingbazaar.com', account: { panel: 'PLAYER', isNew: false, mobileHint: '••••••3210' },
      referral: { code: 'ALICE1', invitedBy: 'alice' } }));
    continueToSite.mockResolvedValue({ redirectUrl: 'https://bettingbazaar.com/#/tg/xyz', message: 'Opening…', created: false });
    const a = app();
    render(<MiniApp app={a} />);
    expect(await screen.findByText(/invited by/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByText(/opening bettingbazaar\.com/i)).toBeTruthy();
    expect(continueToSite).toHaveBeenCalledWith(a.initData, null);
    expect(a.openLink).toHaveBeenCalledWith('https://bettingbazaar.com/#/tg/xyz');
  });
});

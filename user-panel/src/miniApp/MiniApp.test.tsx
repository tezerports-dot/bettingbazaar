// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App shows what the server says the page was opened for, sends the
 * SIGNED contact string (never `responseUnsafe`), and shows refusals verbatim.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { context, approve, continueToSite } = vi.hoisted(() => ({
  context: vi.fn(), approve: vi.fn(), continueToSite: vi.fn(),
}));
vi.mock('./miniAppApi', async (orig) => ({
  ...(await orig<typeof import('./miniAppApi')>()),
  miniApi: { context, approve, continueToSite },
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
  [context, approve, continueToSite].forEach((f) => f.mockReset());
});

describe('the Mini App', () => {
  it('without Telegram\'s launch data, says what to do rather than "open this page from Telegram"', () => {
    render(<MiniApp app={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/telegram did not pass your sign-in/i);
    expect(screen.getByText(/press login with telegram again/i)).toBeTruthy();
  });

  it('opened inside Telegram with no launch data, offers to close the window', () => {
    const empty = { ...app(), initData: '' };
    render(<MiniApp app={empty} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(empty.close).toHaveBeenCalled();
  });

  // Verify is the only thing the page does (owner, 2026-10-14): no separate
  // verification, approval, relink or password reset screen.
  const newAccount = (extra: object = {}) => ctx({
    kind: 'TELEGRAM_LOGIN', panel: 'PLAYER', needsContact: true, state: 'PENDING', delivery: 'HANDOFF',
    destination: 'bettingbazaar.com', account: { panel: 'PLAYER', isNew: true, mobileHint: '' }, ...extra,
  });

  it('shows a mismatched or refused contact as the server words it', async () => {
    context.mockResolvedValue(newAccount());
    approve.mockRejectedValue(new Error('Share your own contact: the one Telegram sent belongs to another Telegram account.'));
    render(<MiniApp app={app()} />);
    fireEvent.click(await screen.findByRole('button', { name: /share contact and verify/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('Share your own contact: the one Telegram sent belongs to another Telegram account.');
  });

  it('sends nothing when the contact share is declined', async () => {
    context.mockResolvedValue(newAccount());
    render(<MiniApp app={app(false)} />);
    fireEvent.click(await screen.findByRole('button', { name: /share contact and verify/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/share your contact/i);
    expect(approve).not.toHaveBeenCalled();
  });

  it('says a new merchant Verify confirms the account an admin created, and relays a refusal when there is none', async () => {
    context.mockResolvedValue(newAccount({ panel: 'MERCHANT', account: { panel: 'MERCHANT', isNew: true, mobileHint: '' } }));
    approve.mockRejectedValue(Object.assign(new Error('There is no merchant account for this mobile number. Ask an admin to create your account with this mobile, then Continue with Telegram again.'), { status: 404, code: 'NO_MERCHANT_ACCOUNT' }));
    const a = app();
    render(<MiniApp app={a} />);
    expect((await screen.findByTestId('verify-account')).textContent).toMatch(/merchant account an admin created/i);
    fireEvent.click(screen.getByRole('button', { name: /share contact and verify/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Ask an admin to create your account/i);
    expect(a.openLink).not.toHaveBeenCalled();
  });

  it('says an expired sign-in is expired, and offers no button', async () => {
    context.mockResolvedValue(newAccount({ state: 'EXPIRED' }));
    render(<MiniApp app={app()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/expired/i);
    expect(screen.queryByRole('button', { name: /verify/i })).toBeNull();
  });

  it('offers no password and no reset, whatever it was opened with', async () => {
    context.mockResolvedValue(ctx({ kind: 'UNKNOWN', panel: null, needsContact: false }));
    render(<MiniApp app={app()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/expired/i);
    expect(document.querySelector('input')).toBeNull();
    expect(screen.queryByText(/password/i)).toBeNull();
  });
});

describe('the Verify screen (Continue with Telegram)', () => {
  const signIn = (extra: object = {}) => ctx({
    kind: 'TELEGRAM_LOGIN', panel: 'PLAYER', needsContact: false, state: 'PENDING',
    destination: 'bettingbazaar.com', account: { panel: 'PLAYER', isNew: false, mobileHint: '••••••3210' },
    request: { at: '2026-10-13T05:00:00Z', ip: '203.0.113.9', city: 'Pune', device: 'Chrome on Windows' }, ...extra,
  });

  it('names where Verify sends them and whose account it enters, and approves only on a press', async () => {
    context.mockResolvedValue(signIn({ delivery: 'HANDOFF', choices: null }));
    approve.mockResolvedValue({ approved: true, message: 'Opening…', redirectUrl: 'https://bettingbazaar.com/#/tg/abc' });
    const a = app();
    render(<MiniApp app={a} />);
    expect(await screen.findByText(/you will be sent to bettingbazaar\.com/i)).toBeTruthy();
    expect(screen.getByTestId('verify-account').textContent).toMatch(/3210/);
    expect(screen.getByTestId('verify-request').textContent).toMatch(/203\.0\.113\.9.*Pune.*Chrome on Windows/);
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

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App shows what the server says the page was opened for, sends the
 * SIGNED contact string (never `responseUnsafe`), and shows refusals verbatim.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { context, approve, signup, passwordReset, playerLogin } = vi.hoisted(() => ({
  context: vi.fn(), approve: vi.fn(), signup: vi.fn(), passwordReset: vi.fn(), playerLogin: vi.fn(),
}));
vi.mock('./miniAppApi', async (orig) => ({
  ...(await orig<typeof import('./miniAppApi')>()),
  miniApi: { context, approve, signup, passwordReset, playerLogin },
}));

import MiniApp from './MiniApp';

const SIGNED = 'contact=%7B%7D&auth_date=1&hash=abc';
const app = (shared = true) => ({
  initData: 'query_id=1&hash=x', ready: vi.fn(), expand: vi.fn(), close: vi.fn(),
  requestContact: vi.fn((cb) => cb(shared, shared ? { response: SIGNED, responseUnsafe: { contact: {} } } : undefined)),
  requestWriteAccess: vi.fn(),
});
const ctx = (start: object, accounts: object[] = []) => ({
  telegramUser: { id: '1', username: 'asha', firstName: 'Asha' }, start, accounts,
});

beforeEach(() => {
  [context, approve, signup, passwordReset, playerLogin].forEach((f) => f.mockReset());
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
    context.mockResolvedValue(ctx({ kind: 'LOGIN', panel: 'STAFF', needsContact: false, state: 'PENDING',
      request: { at: '2026-10-08T05:00:00Z', ip: '203.0.113.9', device: 'Chrome' } }));
    approve.mockResolvedValue({ kind: 'LOGIN', panel: 'STAFF', approved: false, message: 'Refused. Nobody was signed in.' });
    render(<MiniApp app={app()} />);
    expect(await screen.findByText(/203\.0\.113\.9/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(await screen.findByText(/nobody was signed in/i)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(expect.any(String), 'deny', null);
  });

  it('asks a staff member to allow alerts after approving', async () => {
    context.mockResolvedValue(ctx({ kind: 'LOGIN', panel: 'STAFF', needsContact: false, state: 'PENDING' }));
    approve.mockResolvedValue({ kind: 'LOGIN', panel: 'STAFF', approved: true, message: 'Done.' });
    const a = app();
    render(<MiniApp app={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await screen.findByText('Done.');
    expect(a.requestWriteAccess).toHaveBeenCalled();
  });

  it('says an expired request is expired, and offers no button', async () => {
    context.mockResolvedValue(ctx({ kind: 'LOGIN', panel: 'PLAYER', needsContact: false, state: 'EXPIRED' }));
    render(<MiniApp app={app()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/expired/i);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('locks the referral code on a signup opened from a referral link', async () => {
    context.mockResolvedValue(ctx({ kind: 'SIGNUP', panel: 'PLAYER', needsContact: true, referral: { code: 'ALICE1', invitedBy: 'alice' } }));
    render(<MiniApp app={app()} />);
    const box = await screen.findByLabelText(/invite code/i) as HTMLInputElement;
    expect(box.value).toBe('ALICE1');
    expect(box.disabled).toBe(true);
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

  it('asks a player opening it plainly for the player floor, and names the panel', async () => {
    context.mockResolvedValue(ctx({ kind: 'NONE', panel: null, needsContact: false }));
    passwordReset.mockResolvedValue({ panel: 'PLAYER', changed: true, message: 'Changed.' });
    const a = app();
    render(<MiniApp app={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /forgot password/i }));
    expect(screen.getByText(/at least 8 characters/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'Eight-ch' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'Eight-ch' } });
    fireEvent.click(screen.getByRole('button', { name: /share contact and reset/i }));
    expect(await screen.findByText('Changed.')).toBeTruthy();
    expect(passwordReset).toHaveBeenCalledWith(a.initData, SIGNED, { password: 'Eight-ch', confirmPassword: 'Eight-ch', panel: 'PLAYER' });
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
    context.mockResolvedValue(ctx({ kind: 'RESET', panel: 'STAFF', needsContact: true }));
    passwordReset.mockRejectedValue(new Error('That password is one repeated or sequential run of characters.'));
    render(<MiniApp app={app()} />);
    fireEvent.change(await screen.findByLabelText(/^new password$/i), { target: { value: 'aaaaaaaaaaaa' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'aaaaaaaaaaaa' } });
    fireEvent.click(screen.getByRole('button', { name: /share contact and reset/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('That password is one repeated or sequential run of characters.');
  });
});

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * My Authenticator, pressed: the state the server sends, and new recovery
 * codes made with a current app code. The routes are proven against a real
 * database in database/tests/totpPg.test.js and the route tests.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const account = vi.hoisted(() => ({ authenticator: vi.fn(), regenerateRecoveryCodes: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { account } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MyAuthenticator } from './MyAuthenticator';

const STATE = { enrolled: true, enrolledAt: '2026-10-13T10:00:00Z', recoveryCodesLeft: 7, recoveryGeneratedAt: '2026-10-13T10:00:00Z' };
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${'ABCDEFGHJK'[i]}-KLMNP`);

beforeEach(() => {
  account.authenticator.mockReset().mockResolvedValue(STATE);
  account.regenerateRecoveryCodes.mockReset();
});

describe('My Authenticator', () => {
  it('shows the state the server sends', async () => {
    render(<MyAuthenticator />);
    expect(await screen.findByText('Set up')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('makes new codes only with a six-digit code, and shows them once', async () => {
    account.regenerateRecoveryCodes.mockResolvedValue(CODES);
    render(<MyAuthenticator />);
    const box = await screen.findByLabelText('Authenticator code');
    const go = screen.getByRole('button', { name: 'Make new codes' });
    expect(go).toBeDisabled();
    await userEvent.type(box, '123456');
    expect(go).not.toBeDisabled();
    await userEvent.click(go);
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(account.regenerateRecoveryCodes).toHaveBeenCalledWith('123456');
    await userEvent.click(screen.getByRole('button', { name: 'I saved them' }));
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });

  it('says a wrong code in the server\'s words and shows no codes (the opposite case)', async () => {
    account.regenerateRecoveryCodes.mockRejectedValue({ response: { status: 400, data: { success: false, code: 'TOTP_INVALID', message: 'That code is not right.' } } });
    render(<MyAuthenticator />);
    await userEvent.type(await screen.findByLabelText('Authenticator code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Make new codes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That code is not right.'));
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });

  it('offers no regenerate before the app is set up', async () => {
    account.authenticator.mockResolvedValue({ ...STATE, enrolled: false, enrolledAt: null, recoveryCodesLeft: 0 });
    render(<MyAuthenticator />);
    expect(await screen.findByText('Not set up')).toBeTruthy();
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
  });
});

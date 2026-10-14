// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The staff sign-in's code steps (owner, 2026-10-13: an authenticator app, no
 * Telegram). Typed into, against the real store; only the HTTP client is
 * stubbed. A refusal is said in the server's words (`role="alert"`, S44); the
 * first sign-in shows the QR and the key, then the ten recovery codes, and the
 * session is held only after "I saved them".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/sse', () => ({
  default: { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../services/api', () => ({
  default: {
    auth: { login: vi.fn(), totp: vi.fn(), totpSetup: vi.fn(), totpActivate: vi.fn(), logout: vi.fn(), verifySession: vi.fn() },
  },
}));

import api from '../services/api';
import { useAuthStore } from '../services/auth';
import { Login } from './Login';

const ADMIN = { userId: 'a-1', username: 'owner', isAdmin: true };
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${'ABCDEFGHJK'[i]}-KLMNP`);

const refusal = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

const passwordStep = () => {
  render(<MemoryRouter><Login /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9000000001' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
  fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
};

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  useAuthStore.setState({ admin: null, token: null, isAuthenticated: false, isLoading: false });
});

describe('an enrolled account: password, then the code', () => {
  beforeEach(() => {
    (api.auth.login as any).mockResolvedValue({ kind: 'totp', challengeToken: 'c-1', message: 'Enter the 6-digit code from your authenticator app.' });
  });

  it('says a wrong code in the server\'s words and holds no session', async () => {
    (api.auth.totp as any).mockRejectedValue(refusal(401, { success: false, code: 'TOTP_INVALID', message: 'That code is not right. Use the newest one in your app.' }));
    passwordStep();
    const box = await screen.findByLabelText('Code');
    expect(screen.queryByLabelText('Password'), 'the password is still on screen').toBeNull();
    fireEvent.change(box, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That code is not right. Use the newest one in your app.'));
    expect(api.auth.totp).toHaveBeenCalledWith('c-1', '000000');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('signs in on the right code (the opposite case)', async () => {
    (api.auth.totp as any).mockResolvedValue({ token: 't', admin: ADMIN });
    passwordStep();
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(useAuthStore.getState().token).toBe('t');
  });

  it('takes a recovery code in the same box', async () => {
    (api.auth.totp as any).mockResolvedValue({ token: 't', admin: ADMIN, recoveryCodesLeft: 9 });
    passwordStep();
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'abcde-fghij' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(api.auth.totp).toHaveBeenCalledWith('c-1', 'abcde-fghij');
  });

  it('goes back to a clean form', async () => {
    passwordStep();
    await screen.findByLabelText('Code');
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});

describe('the first sign-in: set the app up', () => {
  beforeEach(() => {
    (api.auth.login as any).mockResolvedValue({ kind: 'totpSetup', challengeToken: 's-1', message: 'Set up your authenticator app.' });
    (api.auth.totpSetup as any).mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('shows the QR and the key, then the recovery codes, and holds the session only after "I saved them"', async () => {
    (api.auth.totpActivate as any).mockResolvedValue({ token: 't', admin: ADMIN, recoveryCodes: CODES });
    passwordStep();
    const qr = await screen.findByAltText(/QR code/);
    expect(qr.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByTestId('totp-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(api.auth.totpSetup).toHaveBeenCalledWith('s-1');
    expect(api.auth.totpSetup).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(api.auth.totpActivate).toHaveBeenCalledWith('s-1', '123456');
    expect(useAuthStore.getState().isAuthenticated, 'held before the codes were saved').toBe(false);

    const go = screen.getByRole('button', { name: /Continue/ });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I saved them'));
    expect(go).not.toBeDisabled();
    fireEvent.click(go);
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
  });

  it('says an expired setup in the server\'s words', async () => {
    (api.auth.totpActivate as any).mockRejectedValue(refusal(409, { success: false, code: 'TOTP_SETUP_EXPIRED', message: 'This setup has expired. Sign in again.' }));
    passwordStep();
    fireEvent.change(await screen.findByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This setup has expired. Sign in again.'));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

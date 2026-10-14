// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Install app": shown only where installing is possible; a tap shows the
 * browser's own prompt; Safari is told how; nothing once installed or in the
 * Android app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let native = false;
vi.mock('../services/nativeLifecycle', () => ({ isNativeShell: () => native }));

const ua = navigator.userAgent;
const setUa = (v: string) => Object.defineProperty(window.navigator, 'userAgent', { value: v, configurable: true });

async function fresh() {
  vi.resetModules();
  const svc = await import('../services/installPrompt');
  svc.listenForInstallPrompt();
  const { default: InstallAppButton } = await import('./InstallAppButton');
  return { svc, InstallAppButton };
}

function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome }),
  });
  act(() => { window.dispatchEvent(e); });
  return e;
}

beforeEach(() => { native = false; setUa(ua); });

describe('Install app', () => {
  it('shows nothing until the browser offers an install, then shows its prompt on a tap', async () => {
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    const { InstallAppButton } = await fresh();
    render(<InstallAppButton />);
    expect(screen.queryByRole('button', { name: /install app/i })).toBeNull();
    const e = offerInstall();
    expect(e.defaultPrevented).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: /install app/i }));
    expect(e.prompt).toHaveBeenCalledTimes(1);
    // A kept prompt is shown once: the button goes until the browser offers again.
    expect(screen.queryByRole('button', { name: /install app/i })).toBeNull();
  });

  it('on an iPhone, explains Add to Home Screen', async () => {
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari');
    const { InstallAppButton } = await fresh();
    render(<InstallAppButton />);
    await userEvent.click(screen.getByRole('button', { name: /install app/i }));
    expect(screen.getByRole('status').textContent).toMatch(/share button, then add to home screen/i);
  });

  it('shows nothing in the Android app', async () => {
    native = true;
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    const { InstallAppButton } = await fresh();
    render(<InstallAppButton />);
    offerInstall();
    expect(screen.queryByRole('button', { name: /install app/i })).toBeNull();
  });

  it('goes once the app is installed', async () => {
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
    const { InstallAppButton } = await fresh();
    render(<InstallAppButton />);
    offerInstall();
    expect(await screen.findByRole('button', { name: /install app/i })).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(screen.queryByRole('button', { name: /install app/i })).toBeNull();
  });
});

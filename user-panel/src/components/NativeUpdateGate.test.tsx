// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The Android app's own update screen, pressed.
 *
 * The native plugin is mocked at its boundary (download / install / settings)
 * because jsdom has no Android; what is under test is what the PLAYER sees and
 * what each tap asks the phone to do. The plugin's own refusals — wrong hash,
 * not https, a path outside its folder — are JUnit-tested in
 * android/app/src/test (UpdateVerifierTest).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

let native = true;
vi.mock('../services/nativeLifecycle', () => ({ isNativeShell: () => native }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));

const plugin = {
  download: vi.fn(),
  install: vi.fn(),
  canInstall: vi.fn(),
  openInstallSettings: vi.fn(async () => undefined),
  addListener: vi.fn(async (_e: string, cb: (p: { received: number; total: number }) => void) => {
    cb({ received: 50, total: 100 });
    return { remove: vi.fn() };
  }),
};
let nextCheck: unknown = null;
const snooze = vi.fn();
vi.mock('../services/nativeUpdater', async (orig) => {
  const real = await orig<typeof import('../services/nativeUpdater')>();
  return { ...real, ApkUpdater: plugin, checkForUpdate: vi.fn(async () => nextCheck), snooze };
});

import NativeUpdateGate from './NativeUpdateGate';

const release = (over = {}) => ({
  versionCode: 20, versionName: '4.2.0', downloadUrl: 'https://cdn.example.com/app-4.2.0.apk',
  sha256: 'a'.repeat(64), sizeBytes: 5 * 1024 * 1024, releaseNotes: 'Faster wallet', mandatory: false,
  publishedAt: null, ...over,
});

beforeEach(() => {
  native = true;
  for (const f of Object.values(plugin)) (f as ReturnType<typeof vi.fn>).mockClear();
  snooze.mockClear();
  vi.mocked(plugin.download).mockReset();
  vi.mocked(plugin.install).mockReset();
  localStorage.clear();
});

describe('NativeUpdateGate', () => {
  it('renders nothing on the web', async () => {
    native = false;
    nextCheck = { status: 'required', minRequiredVersionCode: 20, latest: release(), installedVersionCode: 10 };
    const { container } = render(<NativeUpdateGate />);
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the install is current', async () => {
    nextCheck = { status: 'current', minRequiredVersionCode: 0, latest: release(), installedVersionCode: 20 };
    const { checkForUpdate } = await import('../services/nativeUpdater');
    const { container } = render(<NativeUpdateGate />);
    // Wait for THIS render's check to finish, so nothing it started is still
    // in flight when the next test mounts.
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.innerHTML).toBe('');
  });

  it('blocks with no way past it when the update is required', async () => {
    nextCheck = { status: 'required', minRequiredVersionCode: 20, latest: release({ mandatory: true }), installedVersionCode: 10 };
    render(<NativeUpdateGate />);
    expect(await screen.findByText('Update required')).toBeTruthy();
    expect(screen.getByText('Faster wallet')).toBeTruthy();
    expect(screen.queryByText('Later')).toBeNull();
  });

  it('downloads the published file with its hash, then opens the installer', async () => {
    nextCheck = { status: 'available', minRequiredVersionCode: 0, latest: release(), installedVersionCode: 10 };
    plugin.download.mockResolvedValueOnce({ path: '/data/cache/updates/a.apk' });
    plugin.install.mockResolvedValueOnce({ status: 'started' });
    render(<NativeUpdateGate />);
    fireEvent.click(await screen.findByText('Update now'));
    await waitFor(() => expect(screen.getByText(/Tap/)).toBeTruthy());
    expect(plugin.download).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/app-4.2.0.apk', sha256: 'a'.repeat(64), sizeBytes: 5 * 1024 * 1024,
    });
    expect(plugin.install).toHaveBeenCalledWith({ path: '/data/cache/updates/a.apk' });
  });

  it('explains the one-time permission and opens the exact setting', async () => {
    nextCheck = { status: 'required', minRequiredVersionCode: 20, latest: release(), installedVersionCode: 10 };
    plugin.download.mockResolvedValueOnce({ path: '/p.apk' });
    plugin.install.mockResolvedValueOnce({ status: 'needs_permission' });
    render(<NativeUpdateGate />);
    fireEvent.click(await screen.findByText('Update now'));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(plugin.openInstallSettings).toHaveBeenCalledTimes(1);

    plugin.install.mockResolvedValueOnce({ status: 'started' });
    fireEvent.click(screen.getByText("I've allowed it"));
    await waitFor(() => expect(plugin.install).toHaveBeenCalledTimes(2));
  });

  it('shows the plugin refusal and offers to try again', async () => {
    nextCheck = { status: 'available', minRequiredVersionCode: 0, latest: release(), installedVersionCode: 10 };
    plugin.download.mockRejectedValueOnce(new Error('The download was damaged or is not the published update. Please try again.'));
    render(<NativeUpdateGate />);
    fireEvent.click(await screen.findByText('Update now'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/damaged/);
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(plugin.install).not.toHaveBeenCalled();
  });

  it('"Later" postpones an optional update for that version', async () => {
    nextCheck = { status: 'available', minRequiredVersionCode: 0, latest: release(), installedVersionCode: 10 };
    const { container } = render(<NativeUpdateGate />);
    fireEvent.click(await screen.findByText('Later'));
    expect(snooze).toHaveBeenCalledWith(20);
    expect(container.innerHTML).toBe('');
  });
});

describe('shouldShow', () => {
  it('never lets a snooze hide a required update, and a newer version clears it', async () => {
    const { shouldShow } = await vi.importActual<typeof import('../services/nativeUpdater')>('../services/nativeUpdater');
    const now = 1_000_000_000;
    const avail = { status: 'available' as const, minRequiredVersionCode: 0, latest: release(), installedVersionCode: 10 };
    const req = { ...avail, status: 'required' as const };
    const snoozed = { versionCode: 20, at: now - 1000 };
    expect(shouldShow(avail, now, snoozed)).toBe(false);
    expect(shouldShow(req, now, snoozed)).toBe(true);
    expect(shouldShow({ ...avail, latest: release({ versionCode: 21 }) }, now, snoozed)).toBe(true);
    expect(shouldShow(avail, now + 25 * 3600 * 1000, snoozed)).toBe(true);
  });
});

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Android App, pressed (R9). The routes are proven against a real
 * database in backend/tests/routes/androidReleaseControlRoutes; this proves
 * the CONTROLS call them with what they require (§32 S26) and that the card
 * shows what the server sent.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  list: vi.fn(), upload: vi.fn(), update: vi.fn(), publish: vi.fn(), remove: vi.fn(),
  halt: vi.fn(), resume: vi.fn(), fileHref: (r: { fileUrl: string }) => `http://api.test${r.fileUrl}`,
}));
vi.mock('../../services/api', () => ({ androidReleases: api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { AndroidAppPage } from './AndroidAppPage';

const base = {
  packageName: 'com.bettingbazaar.app', signerSha256: 'A'.repeat(64), fileSha256: 'b'.repeat(64),
  sizeBytes: 4_000_000, storage: 'LOCAL', releaseNotes: '', mandatory: false, uploadedAt: '2026-10-01T00:00:00Z',
  haltedAt: null, haltReason: null, halted: false, signatureSchemes: [2, 3],
  uploadedByName: 'owner', publishedByName: 'owner', haltedByName: null,
};
const rel = (over: Record<string, unknown>) => ({ ...base, ...over });
const OFFERED = rel({ releaseId: 'r10', versionCode: 10, versionName: '1.10.0', minSdk: 24, requiresAndroid: 'Android 7.0 (API 24)',
  fileUrl: '/downloads/android/app-10.apk', published: true, publishedAt: '2026-10-01T01:00:00Z' });
const HALTED = rel({ releaseId: 'r12', versionCode: 12, versionName: '1.12.0', minSdk: 24, requiresAndroid: 'Android 7.0 (API 24)',
  fileUrl: '/downloads/android/app-12.apk', published: true, publishedAt: '2026-10-01T02:00:00Z',
  halted: true, haltedAt: '2026-10-01T03:00:00Z', haltReason: 'Crashes on start', haltedByName: 'owner' });
const DRAFT = rel({ releaseId: 'r20', versionCode: 20, versionName: '1.20.0', minSdk: 30, requiresAndroid: 'Android 11 (API 30)',
  fileUrl: '/downloads/android/app-20.apk', published: false, publishedAt: null, signatureSchemes: [] });

beforeEach(() => {
  for (const f of Object.values(api)) if (typeof f === 'function' && 'mockReset' in f) (f as ReturnType<typeof vi.fn>).mockReset();
  api.list.mockResolvedValue({
    success: true, releases: [DRAFT, HALTED, OFFERED], latestPublishedVersionCode: 10, minRequiredVersionCode: 0,
    packageName: 'com.bettingbazaar.app', fingerprints: [], storage: 'LOCAL', checks: [],
  });
  api.halt.mockResolvedValue({ success: true, release: { ...OFFERED, halted: true }, message: '1.10.0 is halted.' });
  api.resume.mockResolvedValue({ success: true, release: { ...HALTED, halted: false } });
});

describe('Android App', () => {
  it('says what phones are offered: the newest release that is NOT halted', async () => {
    render(<AndroidAppPage />);
    expect((await screen.findByText('Players are offered')).parentElement?.textContent).toMatch(/1\.10\.0/);
  });

  it('shows each release\'s Android, its verified signature, and why a halted one was halted', async () => {
    render(<AndroidAppPage />);
    expect(await screen.findByText(/Crashes on start/)).toBeTruthy();
    expect(screen.getAllByText('Android 11 (API 30)').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\(v2, v3\)/).length).toBe(2);
    expect(screen.getByText(/verification not recorded/)).toBeTruthy();
  });

  it('warns that a draft needs a newer Android than the release phones get now', async () => {
    render(<AndroidAppPage />);
    const warning = (await screen.findAllByRole('status')).find((e) => /needs Android 11/.test(e.textContent || ''));
    expect(warning?.textContent).toMatch(/Phones in between will not be offered it/);
  });

  it('Halt asks why, and sends the reason the route requires', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Login broken');
    render(<AndroidAppPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Halt 1.10.0' }));
    await waitFor(() => expect(api.halt).toHaveBeenCalledWith('r10', 'Login broken'));
  });

  it('Halt does nothing when the prompt is cancelled', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<AndroidAppPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Halt 1.10.0' }));
    expect(api.halt).not.toHaveBeenCalled();
  });

  it('Resume offers a halted release again, after a confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AndroidAppPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume 1.12.0' }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith('r12'));
  });

  it('links each release\'s file for downloading', async () => {
    render(<AndroidAppPage />);
    const link = await screen.findByRole('link', { name: 'Download 1.20.0 APK' });
    expect(link.getAttribute('href')).toBe('http://api.test/downloads/android/app-20.apk');
  });
});

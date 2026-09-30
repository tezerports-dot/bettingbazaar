// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * "Update" must lead out of the update screen in BOTH places the app runs.
 *
 * The native case is the one that was broken: the APK's assets are in the
 * package, so a reload shows the same outdated bundle and the same screen. It
 * has to open the APK download instead — and must NOT reload, or the player is
 * put straight back on the screen they were trying to leave.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let native = false;
vi.mock('./nativeLifecycle', () => ({ isNativeShell: () => native }));
vi.mock('./originFailover', () => ({ currentOrigin: () => (native ? 'https://api.example.com' : '') }));

import { startAppUpdate, androidDownloadUrl } from './appUpdate';

describe('startAppUpdate', () => {
  const reload = vi.fn();
  let open: ReturnType<typeof vi.spyOn>;
  const realLocation = window.location;

  beforeEach(() => {
    reload.mockReset();
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  });
  afterEach(() => {
    open.mockRestore();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('in the APK, opens the download at the API origin and does not reload', () => {
    native = true;
    startAppUpdate();
    expect(open).toHaveBeenCalledWith('https://api.example.com/api/download/android', '_blank');
    expect(reload).not.toHaveBeenCalled();
  });

  it('on the web, reloads and opens nothing', async () => {
    native = false;
    startAppUpdate();
    await Promise.resolve();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never points the APK at its own origin', () => {
    // A relative path inside the shell resolves against https://localhost —
    // the handset — and downloads nothing.
    native = true;
    expect(androidDownloadUrl().startsWith('https://api.example.com/')).toBe(true);
  });
});

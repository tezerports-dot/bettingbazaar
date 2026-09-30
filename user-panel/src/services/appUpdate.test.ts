// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The web version gate blocks outdated WEB bundles and nothing else.
 *
 * Inside the APK the bundle is in the package, so this gate would loop: reload,
 * same old assets, same screen. The APK has its own gate (NativeUpdateGate,
 * driven by published releases) — this one must stand aside there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { webBundleOutdated, startAppUpdate } from './appUpdate';

const cmp = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
};

describe('webBundleOutdated', () => {
  it('blocks a web bundle older than the admin minimum', () => {
    expect(webBundleOutdated('4.0.0', '4.1.0', false, cmp)).toBe(true);
  });

  it('never blocks inside the native shell, however old the bundle', () => {
    expect(webBundleOutdated('1.0.0', '9.0.0', true, cmp)).toBe(false);
  });

  it('lets a current or unversioned bundle through', () => {
    expect(webBundleOutdated('4.1.0', '4.1.0', false, cmp)).toBe(false);
    expect(webBundleOutdated('0.0.0', '9.0.0', false, cmp)).toBe(false);
  });
});

describe('startAppUpdate', () => {
  const realLocation = window.location;
  afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: realLocation }); });

  it('reloads to fetch the new bundle', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
    startAppUpdate();
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The native shell's build-time invariants, checked where every CI run sees
 * them — not only the Android workflow, which runs on Android paths alone.
 *
 * 1. One dark ground. manifest.json's theme_color, the Capacitor config and
 *    the Android colour resource must name the same colour. They had drifted
 *    (#0A0E17 in the config against #0B0E14 everywhere else) — §5's "same value
 *    assembled twice", in a place no screen test could see.
 * 2. The committed icons are exactly what scripts/generate-icons.mjs produces,
 *    so the launcher, splash and browser tab cannot drift from one another.
 * 3. No `server.url`. With one, the APK loads the live website into a WebView
 *    and stops being a native app — capacitor.config.ts says so; this makes it
 *    a failure rather than a comment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../../capacitor.config';

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('native shell build invariants', () => {
  const manifest = JSON.parse(readFileSync(at('../../public/manifest.json'), 'utf8'));
  const colours = readFileSync(at('../../android/app/src/main/res/values/ic_launcher_background.xml'), 'utf8');
  const theme = String(manifest.theme_color).toUpperCase();

  it('the Capacitor config paints the same dark ground as the web manifest', () => {
    expect(String(config.backgroundColor).toUpperCase()).toBe(theme);
    const plugins = config.plugins as Record<string, { backgroundColor?: string }>;
    expect(String(plugins.SplashScreen.backgroundColor).toUpperCase()).toBe(theme);
    expect(String(plugins.StatusBar.backgroundColor).toUpperCase()).toBe(theme);
  });

  it('the Android colour resources name the same colour', () => {
    for (const name of ['ic_launcher_background', 'brand_background']) {
      const m = colours.match(new RegExp(`name="${name}">(#[0-9A-Fa-f]{6})<`));
      expect(m?.[1]?.toUpperCase(), name).toBe(theme);
    }
  });

  it('every committed icon matches the generator', () => {
    // Throws (non-zero exit) and prints the stale files if any differ.
    execFileSync('node', [at('../../scripts/generate-icons.mjs'), '--check'], { stdio: 'pipe' });
  });

  it('bundles its UI rather than loading a website', () => {
    expect(config.webDir).toBe('dist');
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.androidScheme).toBe('https');
  });
});

// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Deciding whether a one-time sign-in token may be spent here.
 *
 * This classification gates the only irreversible action the auth page takes.
 * Both directions cost something, and they are not symmetric:
 *
 *   - a MISSED isolated WebView burns the token into storage that is about to
 *     be discarded, leaving the player signed out with nothing to retry;
 *   - a FALSE isolated WebView stops a sign-in that would have worked.
 *
 * The second is worse, so the classifier fails open and the cases below pin
 * that down with real user-agent strings rather than shapes invented here.
 */
import { describe, it, expect } from 'vitest';
import { classifyContext, safariEscapeUrl } from './inAppBrowser';

// Real user-agent strings, kept verbatim — a paraphrased UA tests nothing.
const UA = {
  // Android WebView. The ` wv` token is what the platform stamps on every one.
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  // WKWebView: no `Safari/` token.
  iosWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  // Safari, and SFSafariViewController, both carry `Safari/`.
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const ctx = (userAgent: string, native = false) => classifyContext({ userAgent, native });

describe('classifyContext', () => {
  it('flags an Android WebView — the Telegram in-app browser case', () => {
    expect(ctx(UA.androidWebView)).toBe('isolated-webview');
  });

  it('leaves Android Chrome alone', () => {
    // Also the installed-PWA case: a WebAPK runs on Chrome and shares its
    // profile, so the session persists and must not be interrupted.
    expect(ctx(UA.androidChrome)).toBe('browser');
  });

  it('flags an iOS WKWebView', () => {
    expect(ctx(UA.iosWebView)).toBe('isolated-webview');
  });

  it('leaves iOS Safari alone', () => {
    // SFSafariViewController shares Safari's cookie store and carries the same
    // `Safari/` token, so an app using it establishes a real session. Treating
    // that as isolated would interrupt a sign-in that was going to work.
    expect(ctx(UA.iosSafari)).toBe('browser');
  });

  it('leaves desktop browsers alone', () => {
    expect(ctx(UA.desktopChrome)).toBe('browser');
  });

  it('always reports native inside the Capacitor shell', () => {
    // The shell's storage IS the app's, so this is precisely where the token
    // SHOULD be spent — even though the shell is a WebView and its UA says so.
    expect(ctx(UA.androidWebView, true)).toBe('native');
    expect(ctx(UA.iosWebView, true)).toBe('native');
  });

  it('treats an unrecognised or empty user agent as a real browser', () => {
    // Fail open: an unknown context must not block a sign-in.
    expect(ctx('')).toBe('browser');
    expect(ctx('something nobody has seen before')).toBe('browser');
  });

  it('does not flag desktop Linux for the bare letters "wv"', () => {
    // `\bwv\b` must not match inside an unrelated token; the guard is anchored
    // to Android as well, and this is the regression that would slip past it.
    expect(ctx('Mozilla/5.0 (X11; Linux x86_64; wvware) Chrome/120.0 Safari/537.36')).toBe('browser');
  });
});

describe('safariEscapeUrl', () => {
  it('hands an https URL to Safari with its fragment intact', () => {
    // The fragment is the point: it carries the token, and this is the one
    // escape on either platform that preserves it.
    expect(safariEscapeUrl('https://example.com/#/auth/telegram?token=abc'))
      .toBe('x-safari-https://example.com/#/auth/telegram?token=abc');
  });

  it('refuses anything that is not https', () => {
    // Never a lever for launching some other scheme.
    expect(safariEscapeUrl('http://example.com/#/x')).toBeNull();
    expect(safariEscapeUrl('javascript:alert(1)')).toBeNull();
    expect(safariEscapeUrl('bettingbazaar://auth')).toBeNull();
    expect(safariEscapeUrl('')).toBeNull();
  });
});

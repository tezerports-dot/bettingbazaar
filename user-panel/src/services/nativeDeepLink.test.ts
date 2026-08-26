// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The trust decision behind a bot sign-in link arriving at the native shell.
 *
 * `routeFromDeepLink` is the whole security boundary of the deep-link path, so
 * it is tested directly rather than through the plugin. MainActivity must be
 * exported to receive an App Link at all, which means any app on the device can
 * send it a VIEW intent naming an arbitrary URL — the intent-filter constrains
 * what the OS routes, not what can be delivered by name. Everything this
 * function rejects is a navigation the app would otherwise have performed on
 * a stranger's say-so.
 */
import { describe, it, expect } from 'vitest';
import { routeFromDeepLink } from './nativeDeepLink';

const APP = 'https://bettingbazaar.example';
const API = 'https://api.bettingbazaar.example';
const ALLOWED = [APP, API];

describe('routeFromDeepLink', () => {
  it('accepts the bot sign-in link and keeps the token in the fragment', () => {
    const route = routeFromDeepLink(`${APP}/#/auth/telegram?token=abc123`, ALLOWED);
    expect(route).toBe('#/auth/telegram?token=abc123');
  });

  it('preserves a base64url token verbatim', () => {
    // issueLoginToken mints base64url, which contains - and _ and no padding.
    const token = 'a-B_c9dEfGh-ijkLmn_opQRst0123456789ABCDEFGhij';
    const route = routeFromDeepLink(`${APP}/#/auth/telegram?token=${token}`, ALLOWED);
    expect(route).toBe(`#/auth/telegram?token=${token}`);
  });

  it('accepts a link on any origin the deployment serves', () => {
    expect(routeFromDeepLink(`${API}/#/auth/telegram?token=x`, ALLOWED))
      .toBe('#/auth/telegram?token=x');
  });

  it('rejects a link from an origin this deployment does not serve', () => {
    // The shape a phishing app would send: a real-looking route, wrong origin.
    expect(routeFromDeepLink('https://bettingbazaar.evil/#/auth/telegram?token=x', ALLOWED))
      .toBeNull();
  });

  it('rejects a lookalike host that merely ends with a trusted one', () => {
    expect(routeFromDeepLink('https://evilbettingbazaar.example/#/wallet', ALLOWED))
      .toBeNull();
  });

  it('rejects http even on a trusted host', () => {
    // Origin comparison includes the scheme, so this is not a separate rule —
    // the test exists because "same host" is the mistake it would take.
    expect(routeFromDeepLink('http://bettingbazaar.example/#/wallet', ALLOWED))
      .toBeNull();
  });

  it('rejects a link with no fragment', () => {
    // A bare tap on the site root. There is no route being asked for, and
    // navigating to "/" would be inventing intent the link did not carry.
    expect(routeFromDeepLink(`${APP}/`, ALLOWED)).toBeNull();
  });

  it('rejects a fragment that is not a hash route', () => {
    expect(routeFromDeepLink(`${APP}/#token=abc`, ALLOWED)).toBeNull();
    expect(routeFromDeepLink(`${APP}/#javascript:alert(1)`, ALLOWED)).toBeNull();
  });

  it('rejects a protocol-relative fragment', () => {
    // `#//evil.example` is a hash route by the loosest reading and an
    // off-origin navigation by the browser's.
    expect(routeFromDeepLink(`${APP}/#//evil.example/steal`, ALLOWED)).toBeNull();
  });

  it('rejects a non-http scheme', () => {
    expect(routeFromDeepLink('bettingbazaar://auth/telegram?token=x', ALLOWED)).toBeNull();
  });

  it('rejects anything that is not a URL', () => {
    expect(routeFromDeepLink('', ALLOWED)).toBeNull();
    expect(routeFromDeepLink('not a url', ALLOWED)).toBeNull();
  });

  it('trusts nothing when the allow-list is empty', () => {
    // A build that failed to supply VITE_APP_ORIGIN must not fall open.
    expect(routeFromDeepLink(`${APP}/#/auth/telegram?token=x`, [])).toBeNull();
  });
});

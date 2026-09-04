// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The invite sheet — two links, both of which used to be wrong on Android.
 *
 * ── What this file is defending ─────────────────────────────────────────────
 * Every destination here is configured server-side so a domain change takes
 * effect without rebuilding and shipping an APK, and every one of them has to
 * survive the Capacitor shell, where `window.location.origin` is
 * `https://localhost` — the player's own handset. A relative path resolves
 * against it, renders perfectly, and reaches nothing. That is the exact class
 * of bug `services/apiUrl.ts` was written for, and this modal had two of them:
 *
 *   - the APK button read a `backendUrl` field the server has never sent, and
 *     its `||` fallback was dead code (a template literal is always truthy), so
 *     it always opened a relative path;
 *   - an unset `webUrl` shared the page origin, which in the shell is an
 *     invitation to `https://localhost`.
 *
 * The third defence is the clipboard: the old code called
 * `navigator.clipboard.writeText` unguarded and set "Copied!" on the next line,
 * so it threw in an insecure context and claimed success on a copy that had
 * been refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SystemConfigData } from '../../types';

const API_ORIGIN = 'https://api.bazaar.test';
const PAGE_ORIGIN = window.location.origin;

let config: Partial<SystemConfigData> | null = null;
let configFails = false;
let native = false;

vi.mock('../../services/backend.service', () => ({
  getBackend: () => ({
    getSystemConfig: async () => {
      if (configFails) throw new Error('config unreachable');
      return config;
    },
  }),
  getAssetUrl: (p: string) => p,
}));
vi.mock('../../services/apiUrl', () => ({ apiUrl: (p: string) => `${API_ORIGIN}${p}` }));
vi.mock('../../services/originFailover', () => ({ currentOrigin: () => API_ORIGIN }));
vi.mock('../../services/nativeLifecycle', () => ({ isNativeShell: () => native }));

const { default: ShareModal } = await import('./ShareModal');

/** Install a navigator capability jsdom does not have, and take it away after. */
const installed: string[] = [];
const give = (key: 'share' | 'clipboard', value: unknown) => {
  Object.defineProperty(navigator, key, { configurable: true, value });
  installed.push(key);
};

const open = vi.fn();
let shareSheet: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

/** Render and wait for the system config to land, so no assertion races it. */
const show = async (onClose = () => {}) => {
  render(<ShareModal onClose={onClose} />);
  await screen.findByText('Earn Rewards Together');
  // The config arrives a microtask later and changes both destinations.
  await waitFor(() => expect(screen.getByRole('button', { name: /Share Link|Unavailable/i })).toBeInTheDocument());
};

const shareButton = () => screen.getByRole('button', { name: /Share Link|Copied!|Copy failed|Unavailable/i });
const downloadButton = () => screen.getByRole('button', { name: /Download/i });

beforeEach(() => {
  config = { webUrl: 'https://bazaarclash.example', androidUrl: 'https://cdn.example/app-v9.apk' } as SystemConfigData;
  configFails = false;
  native = false;
  localStorage.clear();
  open.mockReset();
  vi.stubGlobal('open', open);
  shareSheet = vi.fn().mockResolvedValue(undefined);
  writeText = vi.fn().mockResolvedValue(undefined);
  give('clipboard', { writeText });
});

afterEach(() => {
  installed.splice(0).forEach((key) => { delete (navigator as any)[key]; });
});

describe('ShareModal — the APK link', () => {
  it('resolves the download against the API origin, never the page origin', async () => {
    // THE ANDROID BUG. A relative path here points at the handset inside the
    // Capacitor shell, and the button silently downloads nothing.
    await show();
    await userEvent.click(downloadButton());
    expect(open).toHaveBeenCalledWith(`${API_ORIGIN}/api/download/android`, '_blank');
  });

  it('goes through the redirect endpoint rather than the configured APK URL', async () => {
    // /api/download/android 302s to whatever androidUrl an admin has set, so
    // opening the endpoint keeps a swapped build live without a redeploy.
    // Baking the URL into the button would freeze it at page-load time.
    await show();
    await userEvent.click(downloadButton());
    expect(open).not.toHaveBeenCalledWith(expect.stringContaining('cdn.example'), expect.anything());
  });

  it('still offers the download when the config never arrives', async () => {
    // The endpoint is a constant path; it does not need the config to work.
    configFails = true;
    await show();
    await userEvent.click(downloadButton());
    expect(open).toHaveBeenCalledWith(`${API_ORIGIN}/api/download/android`, '_blank');
  });

  it('opens the download outside the app', async () => {
    await show();
    await userEvent.click(downloadButton());
    expect(open.mock.calls[0][1]).toBe('_blank');
  });
});

describe('ShareModal — the web link', () => {
  it('shares the webUrl an admin configured', async () => {
    give('share', shareSheet);
    await show();
    await userEvent.click(shareButton());
    expect(shareSheet).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://bazaarclash.example' }));
  });

  it('follows a domain change without a rebuild', async () => {
    give('share', shareSheet);
    config = { webUrl: 'https://newdomain.example' } as SystemConfigData;
    await show();
    await userEvent.click(shareButton());
    expect(shareSheet).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://newdomain.example' }));
  });

  it('falls back to the page origin on the web', async () => {
    give('share', shareSheet);
    config = {} as SystemConfigData;
    await show();
    await userEvent.click(shareButton());
    expect(shareSheet).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE_ORIGIN }));
  });

  it('NEVER invites a friend to the handset when running in the shell', async () => {
    // `https://localhost` is where the Capacitor shell serves its own assets.
    // Sharing it sends the recipient to their own device, or nowhere.
    give('share', shareSheet);
    config = {} as SystemConfigData;
    native = true;
    await show();
    await userEvent.click(shareButton());
    expect(shareSheet).toHaveBeenCalledWith(expect.objectContaining({ url: API_ORIGIN }));
    expect(shareSheet).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('localhost') }));
  });

  it('offers nothing rather than a link that goes nowhere', async () => {
    // No configured site and no origin to fall back to: a disabled button is
    // honest, a broken invite is not.
    give('share', shareSheet);
    config = {} as SystemConfigData;
    native = true;
    vi.doMock('../../services/originFailover', () => ({ currentOrigin: () => '' }));
    vi.resetModules();
    const { default: Fresh } = await import('./ShareModal');
    render(<Fresh onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Unavailable/i })).toBeDisabled());
    expect(shareSheet).not.toHaveBeenCalled();
    vi.doUnmock('../../services/originFailover');
  });
});

describe('ShareModal — how the link is handed over', () => {
  it('uses the native share sheet when the device has one', async () => {
    give('share', shareSheet);
    await show();
    await userEvent.click(shareButton());
    expect(shareSheet).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when there is no share sheet', async () => {
    await show();
    await userEvent.click(shareButton());
    expect(writeText).toHaveBeenCalledWith('https://bazaarclash.example');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('does not claim "Copied!" when the clipboard refused', async () => {
    // The old code set the label on the line after an unawaited writeText, so a
    // refused copy read as a successful one and the player pasted nothing.
    writeText.mockRejectedValue(new DOMException('Write permission denied.'));
    await show();
    await userEvent.click(shareButton());
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });

  it('survives a browser with no clipboard API at all', async () => {
    // `navigator.clipboard` is undefined in an insecure context; the unguarded
    // call threw a TypeError inside the click handler.
    delete (navigator as any).clipboard;
    installed.splice(installed.indexOf('clipboard'), 1);
    await show();
    await userEvent.click(shareButton());
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('treats a dismissed share sheet as a non-event', async () => {
    // Cancelling the OS sheet rejects. It is not a failure and must not fall
    // through to the clipboard behind the player's back.
    give('share', vi.fn().mockRejectedValue(new DOMException('Share canceled')));
    await show();
    await userEvent.click(shareButton());
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Share Link' })).toBeInTheDocument();
  });
});

describe('ShareModal — chrome', () => {
  it('takes the logo from branding, not from a bundled constant', async () => {
    // GOVERNANCE §3: logos originate from Branding. A bundled logo is wrong the
    // moment the operator rebrands.
    localStorage.setItem('app_branding', JSON.stringify({ cdnBaseUrl: 'https://cdn.example/', logo: 'brand/logo.png' }));
    await show();
    expect(screen.getByAltText('Share logo')).toHaveAttribute('src', 'https://cdn.example/brand/logo.png');
  });

  it('passes an absolute branding logo through untouched', async () => {
    localStorage.setItem('app_branding', JSON.stringify({ cdnBaseUrl: 'https://cdn.example', logo: 'https://other.example/l.png' }));
    await show();
    expect(screen.getByAltText('Share logo')).toHaveAttribute('src', 'https://other.example/l.png');
  });

  it('falls back to the bundled logo only when branding has none', async () => {
    await show();
    expect(screen.getByAltText('Share logo')).toHaveAttribute('src', '/app-assets/logo.png');
  });

  it('does not go down on corrupt branding in localStorage', async () => {
    localStorage.setItem('app_branding', '{not json');
    await show();
    expect(screen.getByAltText('Share logo')).toHaveAttribute('src', '/app-assets/logo.png');
  });

  it('closes when asked', async () => {
    const onClose = vi.fn();
    await show(onClose);
    await userEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

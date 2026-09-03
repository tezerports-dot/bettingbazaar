// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The prompt that appears when the server refuses an action.
 *
 * ── Two properties, both load-bearing, both easy to "improve" away ──────────
 *
 * 1. IT CANNOT BE DISMISSED. Every path this guards is already refused by the
 *    server, so a close button would not restore access — it would hide the one
 *    instruction that does, leaving a player tapping a game that silently
 *    fails. "Add a close button, it's bad UX" is exactly the change this file
 *    is here to catch.
 *
 * 2. IT READS THE CACHE BEFORE IT ASKS TELEGRAM. Activating a replacement
 *    channel bumps the config generation, which staleness every cached
 *    membership in the same instant, so this prompt appears for the ENTIRE
 *    logged-in player base within seconds of each other. If every tap of
 *    "I've joined" went straight to the Bot API, the flip would aim the whole
 *    active user base at Telegram's rate limiter — during the one outage where
 *    nobody can play until they rejoin.
 *
 * The rest is the copy a blocked player is given, which is the only thing
 * standing between them and a support ticket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelGateEvent } from '../../services/apiClient';

/** The webhook grace the component waits out before it asks Telegram directly. */
const GRACE_MS = 1500;

// A faithful stand-in for the emitter: subscribe, get called, unsubscribe on
// unmount. `announceGate` is not exported from apiClient (it fires from inside
// a real HTTP response), so the refusal is pushed in from here instead.
const listeners = new Set<(e: ChannelGateEvent) => void>();
vi.mock('../../services/apiClient', () => ({
  onChannelGate: (fn: (e: ChannelGateEvent) => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
}));
vi.mock('../../services/apiUrl', () => ({ apiUrl: (p: string) => `http://test${p}` }));

const { default: ChannelGateModal } = await import('./ChannelGateModal');

const refuse = (e: Partial<ChannelGateEvent> = {}) =>
  act(() => {
    listeners.forEach((fn) => fn({
      code: 'CHANNEL_MEMBERSHIP_REQUIRED',
      message: '',
      telegram: { inviteLink: 'https://t.me/+officialchannel' },
      ...e,
    } as ChannelGateEvent));
  });

/** Every URL the component asked for, in order. */
const asked = () => (globalThis.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));

const membership = (...answers: unknown[]) => {
  const f = vi.fn();
  answers.forEach((a) => f.mockResolvedValueOnce({ json: async () => a }));
  f.mockResolvedValue({ json: async () => ({ joined: false }) });
  vi.stubGlobal('fetch', f);
};

const checkButton = () => screen.getByRole('button', { name: /I've joined|Checking/i });

/**
 * Let every settled promise run.
 *
 * The tests that cross the webhook grace drive the button with `fireEvent`
 * rather than `userEvent`: userEvent schedules its own timers, which deadlock
 * against a fake clock that only advances when the test says so. fireEvent
 * dispatches synchronously and needs nothing from the clock.
 */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

// jsdom refuses to let `reload` be redefined on a real Location, so the whole
// object is swapped for a plain one carrying the fields anything here reads.
const reload = vi.fn();
Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    href: window.location.href, origin: window.location.origin,
    protocol: window.location.protocol, host: window.location.host,
    pathname: '/', search: '', hash: '', reload,
  },
});

beforeEach(() => {
  listeners.clear();
  membership({ joined: false });
  reload.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChannelGateModal — before a refusal', () => {
  it('renders nothing at all until the server refuses something', () => {
    render(<ChannelGateModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).toBe('');
  });

  it('stops listening when it unmounts', () => {
    // A prompt that keeps a listener alive after unmount would be woken by a
    // later refusal and try to render into a tree that is gone.
    const { unmount } = render(<ChannelGateModal />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe('ChannelGateModal — it cannot be dismissed', () => {
  it('offers no close, cancel, skip or "not now" control', () => {
    render(<ChannelGateModal />);
    refuse();
    expect(screen.queryByRole('button', { name: /close|dismiss|cancel|skip|not now|later|×/i })).toBeNull();
    // The only button in the prompt is the one that makes progress.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(checkButton()).toBeInTheDocument();
  });

  it('survives Escape', async () => {
    render(<ChannelGateModal />);
    refuse();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('survives a click on the backdrop', () => {
    // fireEvent, not userEvent: userEvent clicks the element's centre, which is
    // over the panel. The backdrop itself is what must not dismiss.
    render(<ChannelGateModal />);
    refuse();
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the first refusal when a second arrives underneath it', () => {
    // A page that fires several requests at once gets several refusals. Swapping
    // the prompt would rewrite the instructions under a player mid-read.
    render(<ChannelGateModal />);
    refuse({ code: 'CHANNEL_MEMBERSHIP_REQUIRED' });
    refuse({ code: 'TELEGRAM_NOT_LINKED', telegram: { botUsername: 'bazaar_bot' } });
    expect(screen.getByRole('heading', { name: /Join our Telegram channel/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Link your Telegram/i })).toBeNull();
  });
});

describe('ChannelGateModal — checking membership', () => {
  it('answers from the cache and never contacts Telegram when the join already landed', async () => {
    // THE STAMPEDE GUARD. The webhook writes the cache about a second after the
    // player joins, for free. One request, and `verify=1` nowhere in it.
    membership({ joined: true });
    render(<ChannelGateModal />);
    refuse();
    await userEvent.click(checkButton());

    await screen.findByText(/You're in/i);
    expect(asked()).toEqual(['http://test/api/telegram/membership']);
  });

  it('asks Telegram directly only after the webhook has had its moment', async () => {
    vi.useFakeTimers();
    membership({ joined: false }, { joined: true });
    render(<ChannelGateModal />);
    refuse();
    fireEvent.click(checkButton());
    await flush();

    // Before the grace elapses Telegram has not been asked.
    expect(asked()).toEqual(['http://test/api/telegram/membership']);

    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS + 100); });

    expect(asked()).toEqual([
      'http://test/api/telegram/membership',
      'http://test/api/telegram/membership?verify=1',
    ]);
    expect(screen.getByText(/You're in/i)).toBeInTheDocument();
  });

  it('refuses to start a second check while one is running', async () => {
    // The other half of the stampede guard: one player, one in-flight request,
    // however many times they tap.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<ChannelGateModal />);
    refuse();
    await userEvent.click(checkButton());

    expect(checkButton()).toBeDisabled();
    expect(checkButton()).toHaveTextContent(/Checking/i);
    await userEvent.click(checkButton()).catch(() => {});
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('says "still not in" — naming the Join tap — when Telegram agrees they are out', async () => {
    vi.useFakeTimers();
    membership({ joined: false }, { joined: false });
    render(<ChannelGateModal />);
    refuse();
    fireEvent.click(checkButton());
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS + 100); });

    expect(screen.getByText(/still can't see you in the channel/i)).toBeInTheDocument();
    // The Join tap is emphasised because "I joined" almost always means the
    // player opened the channel and never tapped it.
    expect(screen.getByText('Join', { selector: 'strong' })).toBeInTheDocument();
  });

  it('distinguishes "we are rate-limited" from "you are not a member"', async () => {
    // Telling a player who HAS joined that they have not is how you get a
    // support ticket from someone who did exactly what they were told.
    vi.useFakeTimers();
    membership({ joined: false }, { joined: false, throttled: true });
    render(<ChannelGateModal />);
    refuse();
    fireEvent.click(checkButton());
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS + 100); });

    expect(screen.getByText(/Still checking — give it a few seconds/i)).toBeInTheDocument();
    expect(screen.queryByText(/still can't see you in the channel/i)).toBeNull();
  });

  it('distinguishes a network failure from a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<ChannelGateModal />);
    refuse();
    await userEvent.click(checkButton());

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText(/still can't see you in the channel/i)).toBeNull();
    // And the prompt is still usable — the check button comes back.
    expect(checkButton()).toBeEnabled();
  });

  it('reloads once membership is confirmed, by tap and on its own', async () => {
    // The component cannot know which screens hold stale "you are blocked"
    // state, so a full reload is the honest way to clear all of them.
    vi.useFakeTimers();
    membership({ joined: true });
    render(<ChannelGateModal />);
    refuse();
    fireEvent.click(checkButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(reload).toHaveBeenCalledTimes(1);

    // A player who taps nothing still moves on.
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('ChannelGateModal — where it sends the player', () => {
  const link = (text: RegExp) => screen.getByRole('link', { name: text }) as HTMLAnchorElement;

  it('prefers the invite link the refusal carried', () => {
    render(<ChannelGateModal />);
    refuse({ telegram: { inviteLink: 'https://t.me/+privateinvite', channelUsername: 'public_fallback' } });
    expect(link(/Open the channel/i).href).toBe('https://t.me/+privateinvite');
  });

  it('falls back to the channel username, stripping the leading @', () => {
    render(<ChannelGateModal />);
    refuse({ telegram: { channelUsername: '@bazaar_official' } });
    expect(link(/Open the channel/i).href).toBe('https://t.me/bazaar_official');
  });

  it('follows a channel flip — the destination comes from the refusal, never a constant', () => {
    // The whole reason the invite link rides on the 403: an operator activates
    // a replacement channel and the next refused request carries the new link.
    render(<ChannelGateModal />);
    refuse({ telegram: { inviteLink: 'https://t.me/+replacementchannel' } });
    expect(link(/Open the channel/i).href).toBe('https://t.me/+replacementchannel');
  });

  it('opens Telegram in a new tab with rel=noopener', () => {
    render(<ChannelGateModal />);
    refuse();
    const a = link(/Open the channel/i);
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });

  it('points at support rather than rendering a dead link', () => {
    render(<ChannelGateModal />);
    refuse({ telegram: {} });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/contact support/i)).toBeInTheDocument();
  });

  it('sends an unlinked account to the BOT, not the channel', () => {
    render(<ChannelGateModal />);
    refuse({ code: 'TELEGRAM_NOT_LINKED', telegram: { botUsername: '@bazaar_signin_bot' } });
    expect(screen.getByRole('heading', { name: /Link your Telegram/i })).toBeInTheDocument();
    expect(link(/Open the bot/i).href).toBe('https://t.me/bazaar_signin_bot');
    expect(screen.queryByRole('link', { name: /Open the channel/i })).toBeNull();
  });

  it('reassures an unlinked player that their account is untouched', () => {
    // Players do not link accounts they think will be replaced.
    render(<ChannelGateModal />);
    refuse({ code: 'TELEGRAM_NOT_LINKED', telegram: { botUsername: 'bazaar_signin_bot' } });
    expect(screen.getByText(/your account stays exactly as it is/i)).toBeInTheDocument();
  });

  it('says sign-in is being configured when there is no bot to open', () => {
    render(<ChannelGateModal />);
    refuse({ code: 'TELEGRAM_NOT_LINKED', telegram: {} });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/being configured/i)).toBeInTheDocument();
  });

  it('surfaces the server’s own message alongside the standing copy', () => {
    render(<ChannelGateModal />);
    refuse({ message: 'Membership of @bazaar_official is required.' });
    expect(screen.getByText('Membership of @bazaar_official is required.')).toBeInTheDocument();
    expect(screen.getByText(/your balance, KYC status and referral position are unchanged/i)).toBeInTheDocument();
  });
});

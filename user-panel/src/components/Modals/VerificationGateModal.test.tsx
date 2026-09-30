// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The gate a player cannot get past until they have verified.
 *
 * ── Three properties, all load-bearing, all easy to "improve" away ──────────
 *
 * 1. IT CANNOT BE DISMISSED. Every path it guards is already refused by the
 *    server, so a close button would not restore access — it would hide the one
 *    instruction that does, leaving a player tapping a game that silently
 *    fails. "Add a close button, it's bad UX" is exactly the change this file
 *    is here to catch.
 *
 * 2. IT ASKS, rather than waiting to be told. This was reactive until
 *    2026-09-23 — it appeared only after the server refused something — which
 *    was fine when Telegram was also the signup, because nobody could have an
 *    account without having been through the bot. A form-created account has
 *    verified nothing, so a reactive gate lets somebody wander the app until a
 *    tap fails. The owner's requirement is the opposite: "if not joined they
 *    can't see any other window."
 *
 * 3. IT READS THE CACHE BEFORE IT ASKS TELEGRAM. Activating a replacement
 *    channel bumps the config generation, which makes every cached membership
 *    stale in the same instant, so this prompt appears for the ENTIRE logged-in
 *    player base within seconds of each other. If every tap of "I've done it"
 *    went straight to the Bot API, the flip would aim the whole active user
 *    base at Telegram's rate limiter — during the one outage where nobody can
 *    play until they rejoin.
 *
 * The rest is the copy a blocked player is given, which is the only thing
 * standing between them and a support ticket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerificationState } from '../../services/backend.interface';

/** The webhook grace the component waits out before it asks Telegram directly. */
const GRACE_MS = 1500;

const getVerification = vi.fn();
vi.mock('../../services/backend.service', () => ({
  getBackend: () => ({ getVerification }),
}));

// A faithful stand-in for the emitter: subscribe, get called, unsubscribe on
// unmount. `announceGate` is not exported from apiClient (it fires from inside
// a real HTTP response), so the refusal is pushed in from here instead.
const gateListeners = new Set<() => void>();
vi.mock('../../services/apiClient', () => ({
  onChannelGate: (fn: () => void) => {
    gateListeners.add(fn);
    return () => { gateListeners.delete(fn); };
  },
}));
const refuse = () => act(() => { gateListeners.forEach((fn) => fn()); });

let authenticated = true;
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ isAuthenticated: authenticated }),
}));

const { default: VerificationGateModal } = await import('./VerificationGateModal');

/** A gate answer. Defaults to "share your contact", the first blocking state. */
const state = (over: Partial<VerificationState> = {}): VerificationState => ({
  verified: false,
  reason: 'share_contact',
  contactShared: false,
  channelJoined: false,
  bot: { username: 'bb_signin_7' },
  botLink: 'https://t.me/bb_signin_7?start=verify',
  channel: { inviteLink: 'https://t.me/+officialchannel', username: 'bbofficial' },
  generation: 1,
  ...over,
});

/** Each call answers with the next state in the list; the last one repeats. */
const answers = (...list: VerificationState[]) => {
  let i = 0;
  getVerification.mockImplementation(async () => list[Math.min(i++, list.length - 1)]);
};

/** Every call's options, in order — so "cache first" is measurable. */
const askedLive = () => getVerification.mock.calls.map((c: unknown[]) => Boolean((c[0] as any)?.verify));

/** Mount and let the mount-time read resolve. */
async function mount() {
  const view = render(<VerificationGateModal />);
  await act(async () => { await Promise.resolve(); });
  return view;
}

beforeEach(() => {
  authenticated = true;
  gateListeners.clear();
  getVerification.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('when the player still has something to do', () => {
  it('blocks the screen on its own, without waiting to be refused', async () => {
    answers(state());
    await mount();
    // The point of the 2026-09-23 change: nothing pushed an event in.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(getVerification).toHaveBeenCalled();
  });

  it('offers NO way to close, in any of the three ways a modal usually can', async () => {
    answers(state());
    const { container } = await mount();
    expect(screen.queryByRole('button', { name: /close|dismiss|not now|later|skip/i })).toBeNull();

    // Escape, and a backdrop click. Both must leave it standing.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    const backdrop = container.querySelector('[role="dialog"]') as HTMLElement;
    await userEvent.click(backdrop);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('sends them to THEIR OWN assigned bot, not a generic one', async () => {
    // The fleet's whole consequence for this screen: a player assigned bot #47
    // has a conversation with #47 and with nothing else, so a generic link
    // sends most players to a chat that cannot answer them.
    answers(state());
    await mount();
    const link = screen.getByRole('link', { name: /bb_signin_7/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://t.me/bb_signin_7?start=verify');
  });

  it('sends them to the CHANNEL once the contact is shared', async () => {
    answers(state({ reason: 'join_channel', contactShared: true }));
    await mount();
    const link = screen.getByRole('link', { name: /open the channel/i }) as HTMLAnchorElement;
    expect(link.href).toBe('https://t.me/+officialchannel');
    expect(screen.getByText(/join our telegram channel/i)).toBeTruthy();
  });

  it('shows which step is done, in words and not only in colour', async () => {
    // A tick is a colour and a strikethrough, and neither reaches a screen
    // reader. §32 S24's cousin: on screen is not the same as addressable.
    answers(state({ reason: 'join_channel', contactShared: true }));
    await mount();
    expect(screen.getByText(/verify your mobile on telegram/i).parentElement?.textContent)
      .toMatch(/— done/);
    expect(screen.getByText(/join our official channel/i).parentElement?.textContent)
      .toMatch(/not done yet/);
  });
});

describe('"I\'ve done it" reads the cache before it asks Telegram', () => {
  it('never contacts Telegram when the webhook already recorded it', async () => {
    answers(state(), state({ verified: true, reason: null, contactShared: true, channelJoined: true }));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); });

    // Two reads, neither live. A live check here would be one Bot API call per
    // player per tap, on the flip where every player taps at once.
    expect(askedLive()).toEqual([false, false]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks Telegram ONCE, after the grace, when the cache still says no', async () => {
    answers(state());
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { vi.advanceTimersByTime(GRACE_MS); await Promise.resolve(); });

    expect(askedLive()).toEqual([false, false, true]);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says "checking again shortly" when the server floors the live check', async () => {
    // Distinct from "you have not joined", and the distinction matters: somebody
    // who HAS just joined and is told they have not will go and join again.
    answers(state(), state(), state({ throttled: true }));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { vi.advanceTimersByTime(GRACE_MS); await Promise.resolve(); });
    expect(screen.getByText(/give it a few seconds/i)).toBeTruthy();
  });

  it('says so, and stays, when the server cannot be reached', async () => {
    answers(state());
    await mount();
    getVerification.mockRejectedValue(new Error('offline'));
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/could not reach the server/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the platform\'s own unfinished state is never blamed on the player', () => {
  it('says verification is not available, and offers nothing to press', async () => {
    // A launch sits in exactly this state between deploying and registering the
    // first bot. Telling somebody to open a bot that does not exist is §32 S14
    // on the one screen they cannot get past — and a "check again" button here
    // would be a control that changes nothing (§32 S22).
    answers(state({ reason: 'no_bot', bot: null, botLink: '' }));
    await mount();
    expect(screen.getByText(/verification is not available yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('sends a changed contact to support rather than round the loop again', async () => {
    answers(state({ reason: 'contact_changed' }));
    await mount();
    expect(screen.getByText(/different mobile number/i)).toBeTruthy();
    expect(screen.getByText(/contact support/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
  });
});

describe('when there is nothing to block', () => {
  it('renders nothing for a verified player', async () => {
    answers(state({ verified: true, reason: null, contactShared: true, channelJoined: true }));
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing, and asks nothing, for a signed-out visitor', async () => {
    authenticated = false;
    answers(state());
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getVerification).not.toHaveBeenCalled();
  });

  it('re-reads AT ONCE when the server refuses something', async () => {
    // The instant half. A player who leaves the channel while sitting on a
    // screen is refused on their next action; without this they would keep
    // seeing an un-gated app for up to thirty seconds while every tap failed.
    answers(
      state({ verified: true, reason: null, contactShared: true, channelJoined: true }),
      state({ reason: 'join_channel', contactShared: true }),
    );
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();

    refuse();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/join our telegram channel/i)).toBeTruthy();
  });

  it('does not slam shut on a player who is already in when a read fails', async () => {
    // A blip must not turn into a lockout. The last known answer stands.
    answers(state({ verified: true, reason: null, contactShared: true, channelJoined: true }));
    await mount();
    getVerification.mockRejectedValue(new Error('blip'));
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * GAME CONTEXT — services/GameContext.tsx  v5.0.0
 * ════════════════════════════════════════════════════════════════════════════
 *
 * v5.0.0 — WS-FIRST ARCHITECTURE (zero HTTP for cycle state)
 *
 * CORE CHANGE: Cycles are now initialised exclusively via SSE.
 *   • Server pushes 'cycle_snapshot' immediately on SSE connect.
 *   • Client handles 'cycle_snapshot' → sets both cycles atomically.
 *   • 'new_cycle' / 'cycle_result' / 'cycle_phase' / 'bet_placed' keep state current.
 *   • Timer is derived client-side from cycle.endTime — zero server push needed.
 *   • getCycleState() HTTP is completely gone.
 *   • No socket (2026-10-10): the ONE live connection is the SSE stream
 *     (`realBackend.ts` sseBridge) — public signed out, the player stream
 *     signed in. A fresh snapshot is the stream reopening, which re-sends it.
 *
 * PAYOUT CHANGE: Balance updates come via the 'payout_success' stream event.
 *   • GameEngine pushes payout_success down the winner's player stream with fresh balances.
 *   • No HTTP refresh after result — balance is applied instantly.
 *
 * RESULT TIMING: Declared exactly at 00:00:10 (10 s before cycle end).
 *   • Backend fires completeCycle() at endTime − 10 000 ms.
 *   • The phase arrives from the server (cycle_update); the client derives none of it.
 *   • CycleControl shows celebration display instead of countdown for those 10 s.
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CycleType, GameState, User, Bet, BettingSide, GameCycle, PlayProfile, Board } from '../types';
import { analyticsWindowFor } from '../constants';
import apiClient from './apiClient';
import { getBackend, setCdnBaseUrl } from './backend.service';
import { decodeCyclePhase, decodeCycleResult } from './realtimeProtocol';
import type { SignInStep } from './backend.interface';
import { applyBranding } from './branding';


// All components that need tokenRates should read from here. Stake bounds are
// each board's (`boards`, below); the order sizes are read by the wallet itself
// (Step 2d). Neither is cached here.
interface SysConfig {
  tokenBuyRate:  number;
  tokenSellRate: number;
  // Admin-editable footer tabs (SystemConfig.footerPages) — page keys, ordered.
  footerPages:   string[];
  // Admin › Player Screen (SystemConfig.boardExtras, config.spec.js).
  boardExtras:   BoardExtras;
}
/** Mirrors `boardExtras` in database/spec/config.spec.js (systemConfigPayload.js). */
export interface BoardExtras {
  urgencyChips:       boolean;
  closingWarnSeconds: number;
  resultCelebration:  boolean;
  bonusProgress:      boolean;
  promoCards:         boolean;
}
const DEFAULT_SYS_CONFIG: SysConfig = {
  tokenBuyRate: 1, tokenSellRate: 1,
  footerPages: ['home', 'results', 'winners', 'promo', 'profile'], // schema default
  // schema defaults: true / 10 / true / true / true
  boardExtras: { urgencyChips: true, closingWarnSeconds: 10, resultCelebration: true, bonusProgress: true, promoCards: true },
};
import { useToast } from '../components/ui/Toast';
import { BOARD_RULES_EVENT } from '../redesign/BoardRules';

const backend = getBackend();

/** Fired on `window` with `{ cycleId, amount, winner }` when this player is paid a win. */
export const MY_PAYOUT_EVENT = 'bb:my-payout';

/**
 * Fired on `window`, cancelable, with `{ cycleId, winner, staked, payout }`
 * (rupees) when this player's result for a round is declared: one per player
 * per cycle, all their bets summed (`round_result`, owner 2026-10-10). The
 * board's pop-up calls `preventDefault()` when it is showing that cycle;
 * otherwise this context says it once as a toast.
 */
export const MY_ROUND_EVENT = 'bb:my-round';

interface LiveStats { totalDelhi: number; totalBombay: number; totalPool: number; poolsHidden: boolean; }

/**
 * A cycle's public pools, from any payload that carries them (snapshot,
 * `pool_update`, the SSE `bet_placed`, a result). Mirrors `publicCyclePools`
 * (backend/domains/markets/cyclePublicView.js): from the merge until the
 * result the server sends the total alone, `poolsHidden: true`, and no side.
 */
const poolStats = (d: any): LiveStats => {
  if (d?.poolsHidden) {
    return { totalDelhi: 0, totalBombay: 0, totalPool: Number(d.totalPool) || 0, poolsHidden: true };
  }
  const totalDelhi  = d?.totalDelhi  || d?.delhiPool  || d?.newTotalDelhi  || 0;
  const totalBombay = d?.totalBombay || d?.bombayPool || d?.newTotalBombay || 0;
  return { totalDelhi, totalBombay, totalPool: totalDelhi + totalBombay, poolsHidden: false };
};

/**
 * What the signup form submits.
 *
 * Declared here rather than inline so the form, the context and the backend
 * agree on one shape — a screen that quietly stopped sending `confirmPassword`
 * would be answered "the two passwords do not match" for a field it never
 * filled in.
 */
export interface RegisterForm {
  mobile: string;
  password: string;
  confirmPassword: string;
  /** Pre-filled and non-editable when the player arrived by a referral link. */
  referralCode?: string;
}

interface GameContextType {
  user: User | null;
  isAuthenticated: boolean;
  isOnline: boolean;
  /**
   * Create an account from the signup form. Answers with the Telegram step the
   * account owes before it can be used (Step 3); never seats anybody.
   *
   * Throws with the server's own sentence on a refusal: every one of them names
   * the FIELD that is wrong.
   */
  register: (form: RegisterForm) => Promise<SignInStep>;
  /**
   * Sign in with the mobile and password: seated (`done`), or the Telegram
   * step owed first. A step is deliberately not a throw: the password was
   * right, and the form has a next screen to show.
   */
  signIn: (mobile: string, password: string) => Promise<SignInStep>;
  /** "Login with Telegram": the step to open. */
  signInWithTelegram: () => Promise<SignInStep>;
  /** Ask once whether Telegram has answered; seats the player when it has. */
  pollTelegramStep: (leg: 'challenge' | 'telegramLogin', challengeToken: string) => Promise<'pending' | 'done'>;
  logout: () => void;
  /**
   * The switched-on boards, in the admin's home-page order
   * (`GET /api/v1/boards`). Empty until the first answer arrives.
   */
  boards: Board[];
  /** The board being shown (its key is `cycleType`), or undefined while loading. */
  currentBoard: Board | undefined;
  cycleType: CycleType;
  setCycleType: (type: CycleType) => void;
  isGhostMode: boolean;
  sysConfig: SysConfig;
  toggleGhostMode: () => void;
  cycles: Record<CycleType, GameCycle>;
  currentCycle: GameCycle;
  pastCycles: GameCycle[];
  /**
   * Whose boards this screen shows: the player's profile (VIP or GENERAL),
   * VIP for a visitor. The two never share a cycle (owner, 2026-10-08), so
   * every cycle, result and history row of the other audience is ignored.
   */
  audience: PlayProfile;
  /** Show the boards of this profile (the header switch calls it). */
  setAudience: (audience: PlayProfile) => void;
  /** Fetch one board's full analytics window of results. See the callback. */
  loadCycleHistory: (type: CycleType) => void;
  gameState: GameState;
  serverTimeOffset: number;
  placeBet: (amount: number, side: BettingSide) => Promise<void>;
  placePhantomBet: (amount: number, side: BettingSide) => Promise<void>;
  userBets: Bet[];
  history: string[];
  subscribeToVolume: (type: CycleType, callback: (data: LiveStats) => void) => () => void;
  getCurrentVolume: (type: CycleType) => LiveStats;
  formatTime: (seconds: number) => string;
  updateProfile: (updates: any) => Promise<void>;
  refreshUserWallet: () => Promise<void>;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

/**
 * A board's cycle before its snapshot arrives. Cycles start as this until
 * cycle_snapshot arrives — no local stubs with fake PENDING_ ids, which caused
 * "Cycle not found" errors when a bet was placed before the real cycle landed.
 */
const createNullCycle = (type: CycleType): GameCycle => ({
  id:              `LOADING_${type}`,
  type,
  startTime:       0,
  endTime:         0,
  status:          GameState.OPEN,
  timeRemaining:   0,
  timeRemainingMs: 0,
  totalDelhi:      0,
  totalBombay:     0,
  realDelhi:       0,
  realBombay:      0,
  phantomDelhi:    0,
  phantomBombay:   0,
  phantomBalanced: false,
});
const NO_STATS: LiveStats = Object.freeze({ totalDelhi: 0, totalBombay: 0, totalPool: 0, poolsHidden: false }) as LiveStats;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Merge a balance push into the user. FOUR pockets, not three.
 *
 * This was five hand-written merges, each naming depositBalance,
 * winningsBalance and lockedBalance — and none of them reserveBalance, which
 * `realtimeEmitters.js` has always sent. So the reserve share of every deposit
 * (10% under the ACTIVE policy) never reached the user object, and the shell
 * header, which totals what that object holds, showed a player 900 after a
 * 1,000-token purchase while the wallet screen showed 1,000.
 *
 * One merge, so a sixth caller cannot reintroduce the omission — §5: the same
 * payload assembled in several places drifts, and it drifts silently.
 *
 * `src` is either a stream payload (`depositBalance`…) or a bet result's
 * `balance` (`deposit`…), so both spellings are read.
 */
type BalancePush = Partial<Record<
  'depositBalance' | 'winningsBalance' | 'reserveBalance' | 'lockedBalance' |
  'deposit' | 'winnings' | 'reserve' | 'locked', number>>;

const applyBalances = (prev: User, src: BalancePush): User => ({
  ...prev,
  depositBalance:  src.depositBalance  ?? src.deposit  ?? prev.depositBalance,
  winningsBalance: src.winningsBalance ?? src.winnings ?? prev.winningsBalance,
  reserveBalance:  src.reserveBalance  ?? src.reserve  ?? prev.reserveBalance,
  lockedBalance:   src.lockedBalance   ?? src.locked   ?? prev.lockedBalance,
});

/**
 * The headline figure: deposit + winnings, and NOT the reserve.
 *
 * Two different totals exist for one player and both are correct:
 *
 *   spendableBalance   deposit + winnings. What the shell header shows.
 *   `total` from /api/user/bet-limits
 *                      + reserve as well. What `WalletPage` shows, beside a
 *                      RESERVE tile that accounts for the difference.
 *
 * The reserve is NOT freely spendable — only `betReservePercent` of a stake
 * may be drawn from it — and `backend/routes.js` records the consequence of
 * folding it into a headline figure anyway: players attempted bets the engine
 * then refused. A screen that shows the breakdown can show the larger number;
 * a bare pill in a header cannot.
 *
 * `lockedBalance` is excluded from both: it is a stake already committed to an
 * open bet and is carved OUT of the other pockets when the bet is placed, so
 * adding it would count that money twice.
 *
 * This exists as a named export so the header is not an inline sum that reads
 * like an omission. It was read as one.
 */
export const spendableBalance = (user: Partial<User> | null | undefined): number =>
  (user?.depositBalance || 0) + (user?.winningsBalance || 0);

export const GameProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { addToast } = useToast();
  const [user, setUser]             = useState<User | null>(null);
  // Memory only, never localStorage: a 5-minute half-authenticated credential
  // surviving a reload is a stale secret, not a convenience.
  const [isOnline, setIsOnline]     = useState(true);
  // The first board in the admin's order until the player picks one (set when
  // the boards arrive, and again if the shown board is switched off).
  const [cycleType, setCycleType]   = useState<CycleType>('');
  const [boards, setBoards]         = useState<Board[]>([]);
  const boardsRef = useRef<Board[]>([]);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [sysConfig, setSysConfig] = useState<SysConfig>(DEFAULT_SYS_CONFIG);
  const [userBets, setUserBets]     = useState<Bet[]>([]);
  // Cycles this player has already been told the result of (one notice per round).
  const announcedRef = useRef<Set<string>>(new Set());
  const [history, setHistory]       = useState<string[]>([]);
  const [pastCycles, setPastCycles] = useState<GameCycle[]>([]);
  // The audience whose boards are shown, and the last snapshot of each, so a
  // profile switch shows the other audience's boards at once.
  const [audience, setAudienceState] = useState<PlayProfile>('VIP');
  const audienceRef = useRef<PlayProfile>('VIP');
  const snapshotsRef = useRef<Partial<Record<PlayProfile, any>>>({});
  const applySnapshotRef = useRef<((data: any) => void) | null>(null);
  // serverTimeOffset removed — cycle timing is server-authoritative.
  // Status and timeRemaining come from cycle_update WS events, not local math.
  const serverTimeOffset = 0; // kept for context API compat, components must not use for cycle math
  const isProcessingBet = useRef(false);

  const liveStatsRef = useRef<Record<CycleType, LiveStats>>({});
  const subscribersRef = useRef<Set<{ type: CycleType, cb: (data: LiveStats) => void }>>(new Set());

  const [cycles, setCycles] = useState<Record<CycleType, GameCycle>>({});
  const cyclesRef = useRef(cycles);
  useEffect(() => { cyclesRef.current = cycles; }, [cycles]);

  // ── The boards: rows an admin creates, orders and switches (owner, 2026-10-08)
  // Read on mount, when the app comes back to the foreground, and when an
  // event names a board this list does not hold yet (one created since).
  const loadBoards = useCallback(async () => {
    try {
      const res: any = await apiClient.get('/api/v1/boards');
      const list: Board[] = Array.isArray(res?.boards) ? res.boards : [];
      boardsRef.current = list;
      setBoards(list);
      setCycleType((cur) => (list.some((b) => b.key === cur) ? cur : (list[0]?.key ?? cur)));
    } catch { /* keep the last list; the next foreground or event retries */ }
  }, []);
  useEffect(() => {
    void loadBoards();
    const onVisible = () => { if (document.visibilityState === 'visible') void loadBoards(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadBoards]);
  const loadBoardsRef = useRef(loadBoards);
  loadBoardsRef.current = loadBoards;

  // ── CROSS-2: Fetch branding on init so getAssetUrl() works in production ──
  useEffect(() => {
    // getBranding() is now WS-based — server pushes 'branding' on connect.
    // SystemGuard also fetches branding. If either resolves first, localStorage is set.
    const fetchBranding = async () => {
      try {
        const branding = await (backend as any).getBranding?.();
        if (branding?.cdnBaseUrl) {
          setCdnBaseUrl(branding.cdnBaseUrl);  // in-memory, no localStorage
        }
      } catch { /* branding is non-critical */ }
    };
    fetchBranding();
  }, []);

  // ── SESSION RESTORE: Rehydrate user from stored JWT on every page load ────
  // /auth/me now returns the full profile (balances, bankDetails etc.)
  // so wallet never shows 0 after refresh.
  // We also call getUserData immediately after to load the 50 most recent bets
  // and double-confirm balances from the DB.
  useEffect(() => {
    const restoreSession = async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) return;
      try {
        const res = await (backend as any).getMe?.();
        if (res?.success && res.user) {
          const u = { ...res.user };
          setUser(u);


          // The stream opened with this token (realBackend reads it at open),
          // so this player's pushes and the cycle snapshot are already coming.

          // Load full profile + recent bets from server immediately.
          // /auth/me gives us live balances; getUserData also gives us bets[].
          try {
            const data = await backend.getUserData(u.id);
            if (data?.user) {
              setUser(prev => {
                if (!prev) return null;
                const updated = { ...prev, ...data.user };
                return updated;
              });
            }
            // Populate userBets so BettingCard shows "You: ₹X" for active cycle bets
            if (data?.bets && Array.isArray(data.bets)) {
              setUserBets(data.bets);
            }
          } catch { /* non-critical — balances from /me are already set */ }
        }
      } catch { /* Token expired or invalid — user stays null, login modal appears */ }
    };
    restoreSession();
  }, []);

  // ── CROSS-TAB SESSION SYNC ────────────────────────────────────────────────
  // The bot's sign-in link almost never lands in the tab the player started in.
  // A visitor who arrives from search opens the bot from THIS tab, finishes in
  // Telegram, and the link they tap comes back in a NEW tab (Telegram's "open
  // in browser", or the desktop client handing off to the default browser).
  // localStorage is shared across tabs of an origin, but the restore above runs
  // only on mount — so without this the original tab sits there rendering a
  // logged-out app next to a logged-in one, and the obvious move ("refresh")
  // is not obvious to the person it happens to.
  //
  // `storage` fires only in the OTHER tabs, never the one that made the change,
  // which is exactly the fan-out wanted here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'auth_token') return;

      // Signed in elsewhere. A reload rather than a partial rehydrate: this tab
      // is showing the signed-out app, so there is nothing to lose, and it
      // reuses the mount path above instead of duplicating it — one code path
      // for "become signed in" rather than two that can drift.
      if (e.newValue && !user) {
        window.location.reload();
        return;
      }
      // Signed out elsewhere. Mirror it rather than leaving a stale session
      // rendered against a token that is already gone.
      if (!e.newValue && user) {
        setUser(null);
        setUserBets([]);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [user]);

  /**
   * Merge `cycle_history` rows INTO the stored history by cycle id, never swap.
   *
   * Payloads arrive at three very different depths and a replace cannot serve
   * all three. The stream's open sends 50 rows per type (cheap, enough for the
   * roadmap strip). The drawer asks for the full analytics window of ONE board
   * on demand — 1,440 rows. And the server re-broadcasts the resolved type's
   * recent rows after every result, which for a 1-minute block is once a
   * minute: replacing on that would throw away a 1,440-row window the player
   * just waited for, sixty times an hour.
   *
   * Union by id is idempotent, tolerates out-of-order and overlapping
   * payloads, and lets a shallow refresh top up a deep window instead of
   * truncating it. Rows are then capped per board at its window so the list
   * cannot grow without bound across a long session.
   */
  const mergeCycleHistory = useCallback((rows: any[]) => {
    const incoming: GameCycle[] = (rows || []).map((c: any) => ({
      ...c,
      totalDelhi:  c.totalDelhi  || c.delhiPool  || 0,
      totalBombay: c.totalBombay || c.bombayPool || 0,
    }));
    if (incoming.length === 0) { setIsOnline(true); return; }

    setPastCycles(prev => {
      // Incoming wins on a collision: it is the fresher read of that cycle
      // (a row can arrive mid-settlement and be restated once settled).
      const byId = new Map<string, GameCycle>();
      for (const c of prev)     byId.set(String(c.id), c);
      for (const c of incoming) byId.set(String(c.id), c);

      const kept: GameCycle[] = [];
      const perType: Record<string, number> = {};
      for (const c of [...byId.values()].sort((a, b) => (b.endTime || 0) - (a.endTime || 0))) {
        const t = String(c.type);
        const cap = analyticsWindowFor(boardsRef.current.find((b) => b.key === t));
        const key = `${t}:${c.audience ?? 'VIP'}`;
        if ((perType[key] = (perType[key] || 0) + 1) <= cap) kept.push(c);
      }
      return kept;
    });
    setIsOnline(true);
  }, []);

  /**
   * Ask for one board's full analytics window (`analyticsWindowFor` rows —
   * 1,440 for a repeating board, 30 for a daily one).
   *
   * On demand rather than at stream open: this is ~288 KB and only matters to
   * someone who opens the analytics drawer, while the open is paid by every
   * anonymous visitor on a handset. The server caps a multi-type request far
   * lower for the same reason, so this asks for ONE type at a time, over HTTP
   * (`GET /api/v1/game/cycles/history`), and merges like every other payload.
   */
  const loadCycleHistory = useCallback((type: CycleType) => {
    const limit = analyticsWindowFor(boardsRef.current.find((b) => b.key === type));
    void backend.getCycleHistory(type, limit, audienceRef.current).then(mergeCycleHistory);
  }, [mergeCycleHistory]);

  const setAudience = useCallback((next: PlayProfile) => {
    if (next === audienceRef.current) return;
    audienceRef.current = next;
    setAudienceState(next);
    // The other audience's boards, from the snapshot already received for it.
    // The stream re-broadcasts every audience's snapshot at each new round, and
    // its open sent both audiences' history, so nothing needs asking for.
    const cached = snapshotsRef.current[next];
    if (cached) applySnapshotRef.current?.(cached);
  }, []);

  // History holds both audiences' rows; the screens see their own audience's.
  const myPastCycles = useMemo(
    () => pastCycles.filter((c) => (c.audience ?? 'VIP') === audience),
    [pastCycles, audience],
  );

  // ── BUG-U6: Refresh wallet balance from server ─────────────────────────────
  const refreshUserWallet = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await backend.getUserData(user.id);
      if (data?.user) {
        setUser(prev => {
          if (!prev) return null;
          const updated = { ...prev, ...data.user };
          return updated;
        });
      }
    } catch { /* non-critical */ }
  }, [user?.id]);

  // ZERO-POLL HISTORY: cycle history arrives on the stream — both audiences'
  // recent rows at open, and a board's recent rows after every result.
  useEffect(() => {
    const sseBridge = (backend as any).sseBridge as EventTarget | undefined;
    if (!sseBridge) {
      backend.getCycleHistory().then(mergeCycleHistory).catch(() => {});
      return;
    }
    const onHistory = (e: Event) => mergeCycleHistory((e as any).data?.cycles);
    sseBridge.addEventListener('cycle_history', onHistory);
    return () => sseBridge.removeEventListener('cycle_history', onHistory);
  }, [mergeCycleHistory]);

  const subscribeToVolume = useCallback((type: CycleType, callback: (data: LiveStats) => void) => {
    const sub = { type, cb: callback };
    subscribersRef.current.add(sub);
    callback(liveStatsRef.current[type] ?? NO_STATS);
    return () => { subscribersRef.current.delete(sub); };
  }, []);

  const getCurrentVolume = useCallback((type: CycleType) => liveStatsRef.current[type] ?? NO_STATS, []);

  
  // Extract user id to avoid optional chaining (?.) inside the deps array,
  // which older esbuild targets reject with "Expected ']' but found '?.'".
  const currentUserId = user ? user.id : undefined;

  useEffect(() => {
    const sseBridge = (backend as any).sseBridge as EventTarget | undefined;

    // Helper: subscribe to stream events (public, and this player's own)
    const onSSE = (event: string, handler: (data: any) => void) => {
      if (!sseBridge) return () => {};
      const wrapped = (e: Event) => handler((e as any).data);
      sseBridge.addEventListener(event, wrapped);
      return () => sseBridge.removeEventListener(event, wrapped);
    };

    // ── One place that turns a server event into a board key ───────────────
    // The server names the board in `type`; a few legacy events carry only the
    // cycleId, which starts with the board's id prefix. An event naming a board
    // this list does not hold yet is still applied (the server is the
    // authority) and the list is re-read, so the new board's tab appears.
    // Unattributable events are dropped rather than applied to the wrong tab.
    const toCycleType = (raw: any, cycleId?: string): CycleType | null => {
      const list = boardsRef.current;
      if (typeof raw === 'string' && raw) {
        if (list.length && !list.some((b) => b.key === raw)) void loadBoardsRef.current();
        return raw;
      }
      if (typeof cycleId === 'string') {
        const hit = list.find((b) => cycleId.startsWith(`${b.idPrefix}_`));
        if (hit) return hit.key;
      }
      return null;
    };

    // ── cycle_snapshot: authoritative init pushed by server on connect ───────
    // Arrives via SSE on every connection (SSE sends it on connect).
    
    // Whether an event is about this screen's audience's boards. An event
    // without one predates audiences and is VIP's.
    const mine = (data: any) => (data?.audience ?? 'VIP') === audienceRef.current;

    const handleCycleSnapshot = (data: any) => {
      // Kept per audience, applied only for this screen's (see setAudience).
      snapshotsRef.current[(data?.audience ?? 'VIP') as PlayProfile] = data;
      if (!mine(data)) return;
      const map = data?.cycles || {};

      const applySnapshotType = (rawType: string, ct: CycleType) => {
        const c = map[rawType];
        if (!c) return;
        for (const [pendingCycleId, pending] of pendingBetPlaced) {
          if (pending.cycleType === ct) pendingBetPlaced.delete(pendingCycleId);
        }
        const stats = poolStats(c);
        liveStatsRef.current[ct] = stats;
        subscribersRef.current.forEach(sub => { if (sub.type === ct) sub.cb(liveStatsRef.current[ct]); });
        setCycles(prev => ({
          ...prev,
          [ct]: {
            id:              c.cycleId,
            type:            ct,
            startTime:       c.startTime,
            endTime:         c.endTime,
            status:          (c.status as GameState) || GameState.OPEN,
            // TIMER FIX: snapshot sends timeRemaining (seconds) but NOT timeRemainingMs.
            // CycleControl reads timeRemainingMs first → it was undefined → timer showed 0.
            // Derive ms from seconds here; cycle_update corrects both within 100ms.
            timeRemaining:   typeof c.timeRemaining   === 'number' ? c.timeRemaining   : 0,
            timeRemainingMs: typeof c.timeRemainingMs === 'number' ? c.timeRemainingMs
                           : typeof c.timeRemaining   === 'number' ? c.timeRemaining * 1000 : 0,
            totalDelhi:      stats.totalDelhi,
            totalBombay:     stats.totalBombay,
            totalPool:       stats.totalPool,
            poolsHidden:     stats.poolsHidden,
            realDelhi:       c.realDelhi      || 0,
            realBombay:      c.realBombay     || 0,
            phantomDelhi:    c.phantomDelhi   || 0,
            phantomBombay:   c.phantomBombay  || 0,
            phantomBalanced: c.phantomBalanced || false,
            winner:          c.winner || undefined,
            declaredAt:      c.winner ? Date.now() : undefined,
          },
        }));
      };

      // Every board the snapshot carries — it is the authoritative init, so a
      // board missing here is a tab that stays on LOADING_ until the next
      // new_cycle happens to fire.
      for (const t of Object.keys(map)) {
        const ct = toCycleType(t);
        if (ct) applySnapshotType(t, ct);
      }
      setIsOnline(true);
    };
    applySnapshotRef.current = handleCycleSnapshot;

    // ── ALL HANDLERS DECLARED FIRST (avoids TDZ when minified) ──────────────
    // const/let are not hoisted like function declarations. Registering them with
    

    const pendingBetPlaced = new Map<string, { cycleType: CycleType; stats: LiveStats }>();
    let betPlacedFlushTimer: number | null = null;

    const flushBetPlaced = () => {
      const updates = Array.from(pendingBetPlaced.entries());
      pendingBetPlaced.clear();
      betPlacedFlushTimer = null;
      if (!updates.length) return;
      const currentCycles = cyclesRef.current;
      const appliedUpdates = updates
        .filter(([cycleId, update]) => currentCycles[update.cycleType]?.id === cycleId)
        .map(([, update]) => update);
      for (const { cycleType, stats } of appliedUpdates) {
        liveStatsRef.current[cycleType] = stats;
        subscribersRef.current.forEach(sub => { if (sub.type === cycleType) sub.cb(stats); });
      }
      setCycles(prev => {
        const next = { ...prev };
        for (const { cycleType, stats } of appliedUpdates) {
          next[cycleType] = {
            ...(prev[cycleType] ?? createNullCycle(cycleType)),
            totalDelhi: stats.totalDelhi,
            totalBombay: stats.totalBombay,
            totalPool: stats.totalPool,
            poolsHidden: stats.poolsHidden,
          };
        }
        return next;
      });
    };

    const handleBetPlaced = (data: any) => {
      const ct = toCycleType(data.cycleType, data.cycleId);
      if (!ct) return;
      if (typeof data.cycleId !== 'string' || !data.cycleId) return;
      pendingBetPlaced.set(data.cycleId, { cycleType: ct, stats: poolStats(data) });
      if (betPlacedFlushTimer == null) {
        betPlacedFlushTimer = window.setTimeout(flushBetPlaced, 120);
      }
    };

    const handleNewCycle = (data: any) => {
      // Server created a fresh cycle (sent 12s after cycle_result).
      if (!mine(data)) return;
      const ct = toCycleType(data.type, data.cycleId);
      if (!ct) return;
      for (const [pendingCycleId, pending] of pendingBetPlaced) {
        if (pending.cycleType === ct) pendingBetPlaced.delete(pendingCycleId);
      }
      // BUG-DATE FIX: Always store ms timestamps.
      const parseMs = (v: any): number =>
        typeof v === 'number' ? v : v ? new Date(v).getTime() : 0;
      const etMs = parseMs(data.endTime);
      const initRemaining = etMs > 0 ? Math.max(0, Math.round((etMs - Date.now()) / 1000)) : 0;
      setCycles(prev => ({
        ...prev,
        [ct]: {
          id:              data.cycleId,
          type:            ct,
          startTime:       parseMs(data.startTime),
          endTime:         etMs,
          status:          GameState.OPEN,
          timeRemaining:   initRemaining,
          timeRemainingMs: initRemaining * 1000,
          totalDelhi:      0,
          totalBombay:     0,
          totalPool:       0,
          poolsHidden:     false,
          realDelhi:       0,
          realBombay:      0,
          phantomDelhi:    0,
          phantomBombay:   0,
          phantomBalanced: false,
          winner:          undefined,
          declaredAt:      undefined,
        }
      }));
    };

    const handleCycleResult = (raw: unknown) => {
      // Compact v2 wire format (services/realtimeProtocol.ts); null = unreadable, dropped.
      const data = decodeCycleResult(raw);
      if (!data || !mine(data)) return;
      const ct = toCycleType(data.type, data.cycleId);
      if (!ct) return;
      // The result names both sides again: the pools are no longer hidden.
      const stats = poolStats({ ...data, poolsHidden: false });
      if (stats.totalPool > 0) {
        liveStatsRef.current[ct] = stats;
        subscribersRef.current.forEach(sub => { if (sub.type === ct) sub.cb(stats); });
      }
      setCycles(prev => ({
        ...prev,
        [ct]: {
          ...(prev[ct] ?? createNullCycle(ct)),
          winner:      data.winner as BettingSide,
          status:      GameState.RESULT_DECLARED,
          totalDelhi:  stats.totalDelhi  || prev[ct]?.totalDelhi  || 0,
          totalBombay: stats.totalBombay || prev[ct]?.totalBombay || 0,
          totalPool:   stats.totalPool   || prev[ct]?.totalPool   || 0,
          poolsHidden: false,
          declaredAt:  Date.now()
        }
      }));
    };

    const handlePayoutSuccess = (data: any) => {
      if (data.winningsBalance !== undefined) {
        setUser(prev => {
          if (!prev) return null;
          return applyBalances(prev, data);
        });
      }
      const amount = data.amount || data.payout || 0;
      // The board's result celebration counts this up when it is this cycle's.
      if (amount > 0 && data.cycleId) {
        window.dispatchEvent(new CustomEvent(MY_PAYOUT_EVENT, { detail: { cycleId: String(data.cycleId), amount, winner: data.winner ?? null } }));
      }
      // One notice per round: `round_result` already told this player, so the
      // credit only moves the balance. A payout whose round was never
      // announced (the stream was down at the result) still says so once.
      if (amount > 0 && !announcedRef.current.has(String(data.cycleId))) {
        announcedRef.current.add(String(data.cycleId));
        addToast(`🏆 You Won ₹${amount.toLocaleString()}! Winnings credited.`, 'success');
      }
    };

    const handleRoundResult = (data: any) => {
      const cycleId = data?.cycleId != null ? String(data.cycleId) : '';
      const staked = Number(data?.stakedPaise) / 100;
      const payout = Number(data?.payoutPaise) / 100;
      if (!cycleId || !(staked > 0) || !Number.isFinite(payout) || announcedRef.current.has(cycleId)) return;
      if (announcedRef.current.size > 200) announcedRef.current.clear();
      announcedRef.current.add(cycleId);
      const shown = window.dispatchEvent(new CustomEvent(MY_ROUND_EVENT, {
        cancelable: true, detail: { cycleId, winner: data.winner ?? null, staked, payout },
      }));
      if (!shown) return; // the board's pop-up has it
      if (payout > 0) addToast(`🏆 You Won ₹${payout.toLocaleString()}!`, 'success');
      else addToast(`${data.winner === 'DELHI' ? 'Delhi' : 'Bombay'} won. Your ₹${staked.toLocaleString()} bet did not win this round.`, 'info');
    };

    const handleCyclePhase = (raw: unknown) => {
      // cycle_phase carries the board key `type`; the cycleId is the fallback
      // for an admin action on a cycle whose row could not be read.
      const data = decodeCyclePhase(raw);
      if (!data || !mine(data)) return;
      const ct = toCycleType(data.type, data.cycleId);
      if (!ct) return;
      setCycles(prev => ({ ...prev, [ct]: { ...(prev[ct] ?? createNullCycle(ct)), status: data.phase as GameState } }));
    };

    const handleFireworks = (data: any) => {
      if (!mine(data)) return;
      window.dispatchEvent(new CustomEvent('bazaar_fireworks', { detail: data }));
    };

    const handleCelebration = (data: any) => {
      if (!mine(data)) return;
      window.dispatchEvent(new CustomEvent('bazaar_celebration', { detail: data }));
    };

    const handleUserBalanceUpdate = (data: any) => {
      setUser(prev => {
        if (!prev) return null;
        return applyBalances(prev, data);
      });
    };

    const handleBrandingUpdated = (data: any) => {
      if (!data?.branding) return;
      const b = data.branding;
      // ONE applier (services/branding.ts). This was a second copy, and it had
      // already drifted: it titled the tab from `appName` while App.tsx used
      // `userPanelName`, so which name the tab showed depended on which of the
      // two fired last (§5, §13).
      applyBranding(b);
      window.dispatchEvent(new CustomEvent('branding_updated', { detail: b }));
    };

    // system_config: server pushes this on every connect and on request_system_config.
    // setSysConfig is the SINGLE writer of sysConfig state — single authority per GOVERNANCE.md.
    const handleSystemConfig = (data: any) => {
      if (!data) return;
      setSysConfig(prev => ({
        ...prev,
        tokenBuyRate:  data.tokenBuyRate  ?? prev.tokenBuyRate,
        tokenSellRate: data.tokenSellRate ?? prev.tokenSellRate,
        footerPages:   Array.isArray(data.footerPages) && data.footerPages.length ? data.footerPages : prev.footerPages,
        boardExtras:   data.boardExtras && typeof data.boardExtras === 'object' ? { ...prev.boardExtras, ...data.boardExtras } : prev.boardExtras,
      }));
    };

    // ── Stream subscriptions ─────────────────────────────────────────────────
    // Public events (anonymous visitors too), and — on the player stream only —
    // this player's own pushes. `bet_placed` is the coalesced pool snapshot
    // (≤1/s per live cycle, cycleSnapshotPublisher.js).
    const unsubs = [
      onSSE('cycle_snapshot',      handleCycleSnapshot),
      onSSE('bet_placed',          handleBetPlaced),
      onSSE('new_cycle',           handleNewCycle),
      onSSE('cycle_result',        handleCycleResult),
      onSSE('cycle_phase',         handleCyclePhase),
      onSSE('fireworks',           handleFireworks),
      onSSE('celebration',         handleCelebration),
      onSSE('branding_updated',    handleBrandingUpdated),
      onSSE('system_config',       handleSystemConfig),
      onSSE('round_result',        handleRoundResult),
      onSSE('payout_success',      handlePayoutSuccess),
      onSSE('user_balance_update', handleUserBalanceUpdate),
      // Admin adjust-balance pushes 'user_update' (not 'user_balance_update').
      // Listen to both so admin wallet top-ups reflect instantly without refresh.
      onSSE('user_update',         handleUserBalanceUpdate),
    ];

    return () => {
      if (betPlacedFlushTimer != null) window.clearTimeout(betPlacedFlushTimer);
      unsubs.forEach((off) => off());
    };
  }, [currentUserId, addToast]);

  // ── PERSONAL EVENTS: apply server-pushed data directly, zero HTTP ────────
  useEffect(() => {
    if (!user?.id) return;

    const unsub = backend.subscribeToUserUpdates(user.id, (data: any) => {
      if (data.type === 'ORDER_UPDATE') {
        // Order status changed (merchant accepted, completed, etc.) — dispatch for WalletModal
        window.dispatchEvent(new CustomEvent('bazaar_order_update', { detail: data }));
        // Balance may have changed (deposit credited on COMPLETED) — apply if server sent it
        if (data.depositBalance !== undefined || data.winningsBalance !== undefined) {
          setUser(prev => {
            if (!prev) return null;
            return applyBalances(prev, data);
          });
        }
        return;
      }
      
      if (data.depositBalance !== undefined || data.winningsBalance !== undefined) {
        setUser(prev => {
          if (!prev) return null;
          return applyBalances(prev, data);
        });
      }
    });

    return () => { unsub(); };
  }, [user?.id]);

  // ── AUTH ──────────────────────────────────────────────────────────────────
  // ── AUTH ──────────────────────────────────────────────────────────────────
  // The transport seats the token (realBackend's one seater); this seats the
  // PLAYER, from the user the same response carried. One function for every
  // way in, so none of them can show a wallet the others do not.
  const seatStep = (step: SignInStep): SignInStep => {
    if (step.kind === 'done') setUser({ ...step.user } as User);
    return step;
  };

  const register = async (form: RegisterForm): Promise<SignInStep> => backend.register(form);

  const signIn = async (mobile: string, password: string): Promise<SignInStep> =>
    seatStep(await backend.login(mobile, password));

  const signInWithTelegram = async (): Promise<SignInStep> => backend.loginWithTelegram();

  const pollTelegramStep = async (leg: 'challenge' | 'telegramLogin', challengeToken: string) => {
    const r = await backend.pollSignIn(leg, challengeToken);
    if (r.state === 'done') { setUser({ ...r.user } as User); return 'done' as const; }
    return 'pending' as const;
  };

  const logout = () => {
    setUser(null);
    setUserBets([]);
    setHistory([]);
    setIsGhostMode(false);   // FIX: ghost mode must be cleared on logout
    setAudience('VIP');      // a visitor sees the VIP boards
    localStorage.removeItem('auth_token');
    backend.syncRealtimeSession?.();   // back to the public stream
  };

  // ── BET PLACEMENT ─────────────────────────────────────────────────────────
  const placeBet = useCallback(async (amount: number, side: BettingSide) => {
    if (!user || isProcessingBet.current) return;

    // BUG-U6 fix: use dual balance for availability check
    // Architecture: deposit+winnings already decremented per bet; lockedBalance is a
    // separate tracking counter — do NOT subtract it here (would double-deduct).
    // A GENERAL player stakes the General balance, which the server checks
    // and answers in its own words; this pre-check is the VIP pockets'.
    const availableBalance = (user.depositBalance || 0) + (user.winningsBalance || 0);
    if (audienceRef.current === 'VIP' && availableBalance < amount) {
      addToast('Insufficient Balance', 'error');
      return;
    }

    isProcessingBet.current = true;
    try {
      const cycleId = cycles[cycleType]?.id;
      if (!cycleId) return;
      const result = await backend.placeBet(user.id, cycleId, amount, side);

      // BUG-U4 fix: read result.balance.{deposit,winnings,locked} not result.newBalance
      setUser(prev => {
        if (!prev) return null;
        return applyBalances(prev, result.balance ?? {});
      });

      setUserBets(prev => [result.bet, ...prev]);
    } catch (err: any) {
      // The rules pop-up is the answer to this refusal (redesign/BoardRules.tsx).
      if (err?.code === 'BOARD_RULES_NOT_ACCEPTED') { window.dispatchEvent(new Event(BOARD_RULES_EVENT)); return; }
      addToast(err.message || 'Bet Failed', 'error');
    } finally { isProcessingBet.current = false; }
  }, [user, cycleType, cycles, addToast]);

  const placePhantomBet = useCallback(async (amount: number, side: BettingSide) => {
    if (!user) return;
    try {
      const cycleId = cycles[cycleType]?.id;
      if (!cycleId) return;
      await backend.placePhantomBet(user.id, cycleId, amount, side);
    } catch { addToast('Phantom Failed', 'error'); }
  }, [user, cycleType, cycles, addToast]);

  const updateProfile = async (updates: any) => {
    const updatedUser = await backend.updateUserProfile(user!.id, updates);
    setUser(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...updatedUser };
      return updated;
    });
  };

  const toggleGhostMode = () => setIsGhostMode(prev => !prev);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h === 0
      ? `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${h}:${m}:${s}`;
  };

  // CLIENT TICK REMOVED.
  // Status and timeRemaining are 100% server-authoritative.
  // The server pushes cycle_update every second with status + timeRemaining.
  // CycleControl smooths the display with a local decrement between pushes.

  const currentCycle = cycles[cycleType] ?? createNullCycle(cycleType);
  const currentBoard = boards.find((b) => b.key === cycleType);

  return (
    <GameContext.Provider value={{
      user, isAuthenticated: !!user, isOnline, register, signIn, signInWithTelegram, pollTelegramStep, logout,
      boards, currentBoard,
      cycleType, setCycleType, cycles, currentCycle,
      pastCycles: myPastCycles, audience, setAudience, loadCycleHistory, gameState: currentCycle.status, serverTimeOffset,
      placeBet, placePhantomBet, userBets, history, formatTime,
      updateProfile, subscribeToVolume, getCurrentVolume, refreshUserWallet,
      isGhostMode,
    toggleGhostMode,
    sysConfig,
    }}>
      {children}
    </GameContext.Provider>
  );
};

/**
 * Admin › Player Screen's switches, for screens that may render outside the
 * provider (a page under test): the schema defaults there.
 */
export const useBoardExtras = (): BoardExtras =>
  useContext(GameContext)?.sysConfig.boardExtras ?? DEFAULT_SYS_CONFIG.boardExtras; // schema defaults

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) throw new Error('useGame must be used within a GameProvider');
  return context;
};

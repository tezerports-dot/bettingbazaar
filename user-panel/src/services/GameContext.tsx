// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 *   • refreshCycles() is gone — replaced by requestCycleSnapshot().
 *
 * PAYOUT CHANGE: Balance updates come via 'payout_success' WS event.
 *   • GameEngine emits payout_success to user-{id} room with fresh balances.
 *   • No HTTP refresh after result — balance is applied instantly.
 *
 * RESULT TIMING: Declared exactly at 00:00:10 (10 s before cycle end).
 *   • Backend fires completeCycle() at endTime − 10 000 ms.
 *   • Frontend GAME_CORE.getPhaseStatus() returns RESULT_DECLARED at ≤10 s.
 *   • CycleControl shows celebration display instead of countdown for those 10 s.
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { CycleType, GameState, User, Bet, BettingSide, GameCycle } from '../types';
import { ANALYTICS_WINDOW } from '../constants';
import { getBackend, setCdnBaseUrl } from './backend.service';


// All components that need minBet / minDeposit / tokenRates should read from here.
interface SysConfig {
  minBet:        number;
  maxBet:        number;
  maxFullDayBet: number;
  minDeposit:    number;
  maxDeposit:    number;
  minWithdrawal: number;
  maxWithdrawal: number;
  tokenBuyRate:  number;
  tokenSellRate: number;
  // Admin-editable footer tabs (SystemConfig.footerPages) — page keys, ordered.
  footerPages:   string[];
}
const DEFAULT_SYS_CONFIG: SysConfig = {
  minBet: 10, maxBet: 100000, maxFullDayBet: 500000,
  minDeposit: 100, maxDeposit: 50000,
  minWithdrawal: 100, maxWithdrawal: 50000,
  tokenBuyRate: 1, tokenSellRate: 1,
  footerPages: ['home', 'results', 'winners', 'promo', 'profile'], // schema default
};
import { logger } from './logging.service';
import { useToast } from '../components/ui/Toast';
// getPhaseStatus removed: phase/status is now 100% server-authoritative via cycle_update events.

const backend = getBackend();

interface LiveStats { totalDelhi: number; totalBombay: number; }

interface GameContextType {
  user: User | null;
  isAuthenticated: boolean;
  isOnline: boolean;
  /**
   * Redeem a bot login link. The single entry point to an authenticated
   * session — there is no password login and no registration, because a
   * player's identity is established inside Telegram before this is reached.
   */
  completeTelegramLogin: (token: string) => Promise<void>;
  logout: () => void;
  cycleType: CycleType;
  setCycleType: (type: CycleType) => void;
  isGhostMode: boolean;
  sysConfig: SysConfig;
  toggleGhostMode: () => void;
  cycles: { [key in CycleType]: GameCycle };
  currentCycle: GameCycle;
  pastCycles: GameCycle[];
  /** Fetch one board's full ANALYTICS_WINDOW of results. See the callback. */
  loadCycleHistory: (type: CycleType) => void;
  gameState: GameState;
  serverTimeOffset: number;
  placeBet: (amount: number, side: BettingSide) => Promise<void>;
  placePhantomBet: (amount: number, side: BettingSide) => Promise<void>;
  userBets: Bet[];
  history: string[];
  subscribeToVolume: (type: CycleType, callback: (data: LiveStats) => void) => () => void;
  getCurrentVolume: (type: CycleType) => LiveStats;
  triggerAdminAction: (action: string, payload?: any) => void;
  formatTime: (seconds: number) => string;
  updateProfile: (updates: any) => Promise<void>;
  refreshUserWallet: () => Promise<void>;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

// ── Helpers ──────────────────────────────────────────────────────────────────

const getCycleTimes = (type: CycleType, refTimeMs: number) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(refTimeMs + IST_OFFSET);
  let startMs: number;
  let endMs: number;

  if (type === CycleType.THIRTY_MIN) {
    const minutes = istTime.getUTCMinutes();
    const seconds = istTime.getUTCSeconds();
    const blockStartMinute = minutes < 30 ? 0 : 30;
    const elapsedInBlock = ((minutes - blockStartMinute) * 60 * 1000) + (seconds * 1000);
    startMs = refTimeMs - elapsedInBlock;
    endMs   = startMs + (30 * 60 * 1000);
  } else {
    const currentIstYear  = istTime.getUTCFullYear();
    const currentIstMonth = istTime.getUTCMonth();
    const currentIstDate  = istTime.getUTCDate();
    const today1800_IST   = Date.UTC(currentIstYear, currentIstMonth, currentIstDate, 18, 0, 0, 0);
    const today1800_Real  = today1800_IST - IST_OFFSET;
    if (refTimeMs < today1800_Real) {
      endMs   = today1800_Real;
      startMs = endMs - (24 * 3600 * 1000);
    } else {
      startMs = today1800_Real;
      endMs   = startMs + (24 * 3600 * 1000);
    }
  }
  return { startTime: startMs, endTime: endMs };
};

/** Compute walletBalance from dual-balance fields for Header/ProfilePage */
const computeWalletBalance = (user: Partial<User>): number =>
  (user.depositBalance || 0) + (user.winningsBalance || 0);

// Read ?ref= from URL and persist for registration
if (typeof window !== 'undefined') {
  const _hashParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const _refFromUrl = _hashParams.get('ref');
}

export const GameProvider: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const { addToast } = useToast();
  const [user, setUser]             = useState<User | null>(null);
  // Memory only, never localStorage: a 5-minute half-authenticated credential
  // surviving a reload is a stale secret, not a convenience.
  const [isOnline, setIsOnline]     = useState(true);
  const [cycleType, setCycleType]   = useState<CycleType>(CycleType.THIRTY_MIN);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [sysConfig, setSysConfig] = useState<SysConfig>(DEFAULT_SYS_CONFIG);
  const [userBets, setUserBets]     = useState<Bet[]>([]);
  const [history, setHistory]       = useState<string[]>([]);
  const [pastCycles, setPastCycles] = useState<GameCycle[]>([]);
  // serverTimeOffset removed — cycle timing is server-authoritative.
  // Status and timeRemaining come from cycle_update WS events, not local math.
  const serverTimeOffset = 0; // kept for context API compat, components must not use for cycle math
  const isProcessingBet = useRef(false);
  const isRefreshing    = useRef(false);

  const liveStatsRef = useRef<{ [key in CycleType]: LiveStats }>({
    [CycleType.ONE_MIN]:    { totalDelhi: 0, totalBombay: 0 },
    [CycleType.THIRTY_MIN]: { totalDelhi: 0, totalBombay: 0 },
    [CycleType.FULL_DAY]:   { totalDelhi: 0, totalBombay: 0 }
  });
  const subscribersRef = useRef<Set<{ type: CycleType, cb: (data: LiveStats) => void }>>(new Set());

  // ── WS-FIRST INIT: cycles start as null until cycle_snapshot arrives ──────
  // No local stubs with fake PENDING_ IDs — those caused "Cycle not found" errors
  // when a bet was placed before syncWithServer replaced the stub.
  // The server pushes cycle_snapshot within ~1 RTT of connect, so the null
  // window is practically invisible.
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

  const [cycles, setCycles] = useState<{ [key in CycleType]: GameCycle }>({
    [CycleType.ONE_MIN]:    createNullCycle(CycleType.ONE_MIN),
    [CycleType.THIRTY_MIN]: createNullCycle(CycleType.THIRTY_MIN),
    [CycleType.FULL_DAY]:   createNullCycle(CycleType.FULL_DAY),
  });
  const cyclesRef = useRef(cycles);
  useEffect(() => { cyclesRef.current = cycles; }, [cycles]);

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
  // /auth/me now returns the full profile (balances, kycData, bankDetails etc.)
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
          u.walletBalance = computeWalletBalance(u);
          setUser(u);

          
          const socket = (backend as any).socket;
          if (socket?.connected && u.id) {
            socket.emit('join_user_room', u.id);
          } else if (socket && u.id) {
            socket.once('connect', () => socket.emit('join_user_room', u.id));
          }

          // Request a fresh cycle snapshot — arrives within 1 RTT.
          requestCycleSnapshot();

          // Load full profile + recent bets from server immediately.
          // /auth/me gives us live balances; getUserData also gives us bets[].
          try {
            const data = await backend.getUserData(u.id);
            if (data?.user) {
              setUser(prev => {
                if (!prev) return null;
                const updated = { ...prev, ...data.user };
                updated.walletBalance = computeWalletBalance(updated);
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── WS-FIRST: request a fresh snapshot instead of HTTP fetch ───────────────
  const requestCycleSnapshot = useCallback(() => {
    const socket = (backend as any).socket;
    if (socket?.connected) {
      socket.emit('request_cycle_snapshot');
    }
  }, []);

  // Keep refreshCycles as a thin alias so any remaining callers compile.
  // It now triggers a WS snapshot request, NOT an HTTP fetch.
  const refreshCycles = requestCycleSnapshot;

  /**
   * Ask for one board's full analytics window (ANALYTICS_WINDOW rows for that
   * type — 1,440 for the 1-minute and 30-minute boards).
   *
   * On demand rather than on connect: this is ~288 KB and only matters to
   * someone who opens the analytics drawer, while connect is paid by every
   * anonymous visitor on a handset. The server caps a multi-type request far
   * lower for the same reason, so this asks for ONE type at a time.
   *
   * Fire-and-forget, deliberately. The response arrives on the same passive
   * `cycle_history` listener as every other payload and merges by id there —
   * awaiting it would race the once-a-minute post-result broadcast, which is
   * the same event name, and resolve with 50 rows instead of the deep window.
   */
  const loadCycleHistory = useCallback((type: CycleType) => {
    const socket = (backend as any).socket;
    if (!socket?.connected) return;
    const limit = ANALYTICS_WINDOW[type as string] ?? ANALYTICS_WINDOW['30_MIN'];
    socket.emit('request_cycle_history', { type, limit });
  }, []);

  // ── BUG-U6: Refresh wallet balance from server ─────────────────────────────
  const refreshUserWallet = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await backend.getUserData(user.id);
      if (data?.user) {
        setUser(prev => {
          if (!prev) return null;
          const updated = { ...prev, ...data.user };
          // BUG-U6 fix: always compute walletBalance
          updated.walletBalance = computeWalletBalance(updated);
          return updated;
        });
      }
    } catch { /* non-critical */ }
  }, [user?.id]);

  // ZERO-POLL HISTORY: cycle history arrives via SSE (public broadcast).
  // SSE delivers cycle_history on connect AND after every cycle_result automatically.
  
  useEffect(() => {
    const sseBridge = (backend as any).sseBridge as EventTarget | undefined;
    const socket    = (backend as any).socket;

    // Every `cycle_history` payload is MERGED INTO the stored history by cycle
    // id, never swapped for it.
    //
    // Payloads arrive at three very different depths and a replace cannot serve
    // all three. Connect sends 50 rows per type (cheap, enough for the roadmap
    // strip). The drawer asks for the full ANALYTICS_WINDOW of ONE board on
    // demand — 1,440 rows. And the server re-broadcasts the resolved type's
    // recent rows after every result, which for a 1-minute block is once a
    // minute: replacing on that would throw away a 1,440-row window the player
    // just waited for, sixty times an hour, and replacing only the named types
    // would still do it to the board they are actually looking at.
    //
    // Union by id is idempotent, tolerates out-of-order and overlapping
    // payloads, and lets a shallow refresh top up a deep window instead of
    // truncating it. Rows are then capped per type at ANALYTICS_WINDOW so the
    // list cannot grow without bound across a long session.
    const handleCycleHistory = (data: { cycles: any[]; types?: string[] }) => {
      const incoming: GameCycle[] = (data.cycles || []).map((c: any) => ({
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
          const cap = ANALYTICS_WINDOW[t] ?? ANALYTICS_WINDOW['30_MIN'];
          if ((perType[t] = (perType[t] || 0) + 1) <= cap) kept.push(c);
        }
        return kept;
      });
      setIsOnline(true);
    };

    // Primary: SSE bridge (works for ALL users — anonymous included)
    let sseHandler: ((e: Event) => void) | null = null;
    if (sseBridge) {
      sseHandler = (e: Event) => handleCycleHistory((e as any).data);
      sseBridge.addEventListener('cycle_history', sseHandler);
    }

    
    if (socket) {
      socket.on('cycle_history', handleCycleHistory);
      socket.emit('request_cycle_history', { limit: 50 });
    }

    // Tertiary: HTTP fallback if neither is available yet
    if (!socket && !sseBridge) {
      backend.getCycleHistory().then(hist => {
        if (hist.length) { setPastCycles(hist); setIsOnline(true); }
      }).catch(() => {});
    }

    return () => {
      if (sseBridge && sseHandler) sseBridge.removeEventListener('cycle_history', sseHandler);
      if (socket) socket.off('cycle_history', handleCycleHistory);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const subscribeToVolume = useCallback((type: CycleType, callback: (data: LiveStats) => void) => {
    const sub = { type, cb: callback };
    subscribersRef.current.add(sub);
    callback(liveStatsRef.current[type]);
    return () => { subscribersRef.current.delete(sub); };
  }, []);

  const getCurrentVolume = useCallback((type: CycleType) => liveStatsRef.current[type], []);

  
  // Extract user id to avoid optional chaining (?.) inside the deps array,
  // which older esbuild targets reject with "Expected ']' but found '?.'".
  const currentUserId = user ? user.id : undefined;

  useEffect(() => {
    const socket    = (backend as any).socket;
    const sseBridge = (backend as any).sseBridge as EventTarget | undefined;

    // Helper: subscribe to SSE bridge events (public broadcasts)
    const onSSE = (event: string, handler: (data: any) => void) => {
      if (!sseBridge) return () => {};
      const wrapped = (e: Event) => handler((e as any).data);
      sseBridge.addEventListener(event, wrapped);
      return () => sseBridge.removeEventListener(event, wrapped);
    };

    // ── Cycle-room watching (realtime cost fix) ──────────────────────────────
    // We tell the server which cycle(s) we are viewing so it can scope the
    // coalesced pool_update snapshot to watchers instead of broadcasting to
    // every connection. `desired` is the id per cycle type; `watched` is what
    // we've actually joined. syncWatched(patch) reconciles the two — join new,
    // leave stale — and is called whenever the live cycles change.
    const desired: Record<string, string | undefined> = {};
    const watched = new Set<string>();

    // ── The SSE half of the same subscription ────────────────────────────────
    // `pool_update` is Socket.IO-only, so a client whose WebSocket is blocked
    // or dropped has the SSE `bet_placed` stream as its ONLY live-pool path.
    // The server used to broadcast that to every connection, which meant every
    // client with a healthy socket processed each cycle's totals twice — once
    // room-scoped over the socket, once globally over SSE. The server now scopes
    // it to subscribers (sseManager cycle topics), so this side decides when to
    // subscribe: only while the socket is NOT carrying them.
    //
    // `socketFailed` is a latch, not `socket.connected`. The socket is
    // legitimately disconnected for the first moment of every page load, and
    // reading `.connected` here would subscribe during that window and
    // unsubscribe a moment later — two EventSource reconnects on every load, to
    // avoid a duplication that was never happening. It flips only on a real
    // failure, and back on a real connect.
    let socketFailed = !socket;
    const syncSseCycles = () => {
      const bridge = sseBridge as unknown as { setCycles?: (ids: string[]) => void } | undefined;
      if (!bridge?.setCycles) return;
      bridge.setCycles(socketFailed
        ? (Object.values(desired).filter(Boolean) as string[])
        : []);
    };

    const syncWatched = (patch: Record<string, string | undefined>) => {
      Object.assign(desired, patch);
      syncSseCycles();
      if (!socket) return;
      const want = new Set(Object.values(desired).filter(Boolean) as string[]);
      for (const id of Array.from(watched)) {
        if (!want.has(id)) { socket.emit('unwatch_cycle', { cycleId: id }); watched.delete(id); }
      }
      for (const id of want) {
        if (!watched.has(id)) { socket.emit('watch_cycle', { cycleId: id }); watched.add(id); }
      }
    };
    // ── One place that turns a server type string into a CycleType ──────────
    // Five handlers each had their own version of this, and every one ended in
    // `: CycleType.FULL_DAY`. That fallback was harmless while there were two
    // types and became a bug the moment there were three: a 1_MIN event with a
    // type field the branch did not recognise was filed as FULL_DAY, so the
    // 1-minute tab never updated and the full-day tab showed someone else's
    // pools.
    //
    // The cycleId sniff stays as a last resort because some legacy events carry
    // no type at all, but it is now keyed off the registry's id prefixes rather
    // than a single hardcoded '30MIN'.
    const CYCLE_ID_PREFIXES: Array<[string, CycleType]> = [
      ['1MIN_',    CycleType.ONE_MIN],
      ['30MIN_',   CycleType.THIRTY_MIN],
      ['FULLDAY_', CycleType.FULL_DAY],
    ];
    const toCycleType = (raw: any, cycleId?: string): CycleType | null => {
      const known = Object.values(CycleType).find(v => v === raw);
      if (known) return known as CycleType;
      if (typeof cycleId === 'string') {
        const hit = CYCLE_ID_PREFIXES.find(([prefix]) => cycleId.startsWith(prefix));
        if (hit) return hit[1];
      }
      // Unattributable: better to drop the event than to apply it to the wrong
      // tab, which is what every previous fallback did.
      return null;
    };

    // ── cycle_snapshot: authoritative init pushed by server on connect ───────
    // Arrives via SSE on every connection (SSE sends it on connect).
    
    const handleCycleSnapshot = (data: any) => {
      const map = data?.cycles || {};

      const applySnapshotType = (rawType: string, ct: CycleType) => {
        const c = map[rawType];
        if (!c) return;
        for (const [pendingCycleId, pending] of pendingBetPlaced) {
          if (pending.cycleType === ct) pendingBetPlaced.delete(pendingCycleId);
        }
        const totalDelhi  = c.totalDelhi  || c.delhiPool  || 0;
        const totalBombay = c.totalBombay || c.bombayPool || 0;
        liveStatsRef.current[ct] = { totalDelhi, totalBombay };
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
            totalDelhi,
            totalBombay,
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

      // Every type, from the enum — the snapshot is the authoritative init, so a
      // type missing here is a tab that stays on LOADING_ until the next
      // new_cycle happens to fire.
      for (const t of Object.values(CycleType)) applySnapshotType(t, t);
      // Watch exactly the live cycles the snapshot just described.
      syncWatched(Object.fromEntries(
        Object.values(CycleType).map(t => [t, map[t]?.cycleId]),
      ));
      setIsOnline(true);
    };

    // Request snapshot on every (re)connect so cycles are never stale after a
    // server restart or temporary network drop. The server drops our room
    // membership on disconnect, so forget what we thought we were watching and
    // let the fresh snapshot re-join us.
    const handleReconnect = () => {
      watched.clear();
      socket?.emit('request_cycle_snapshot');
    };

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
        .filter(([cycleId, update]) => currentCycles[update.cycleType].id === cycleId)
        .map(([, update]) => update);
      for (const { cycleType, stats } of appliedUpdates) {
        liveStatsRef.current[cycleType] = stats;
        subscribersRef.current.forEach(sub => { if (sub.type === cycleType) sub.cb(stats); });
      }
      setCycles(prev => {
        const next = { ...prev };
        for (const { cycleType, stats } of appliedUpdates) {
          next[cycleType] = {
            ...prev[cycleType],
            totalDelhi: stats.totalDelhi,
            totalBombay: stats.totalBombay,
          };
        }
        return next;
      });
    };

    const handleBetPlaced = (data: any) => {
      const ct = toCycleType(data.cycleType, data.cycleId);
      if (!ct) return;
      if (typeof data.cycleId !== 'string' || !data.cycleId) return;
      pendingBetPlaced.set(data.cycleId, {
        cycleType: ct,
        stats: {
          totalDelhi:  data.newTotalDelhi  || 0,
          totalBombay: data.newTotalBombay || 0,
        },
      });
      if (betPlacedFlushTimer == null) {
        betPlacedFlushTimer = window.setTimeout(flushBetPlaced, 120);
      }
    };

    // pool_update is the canonical coalesced snapshot (≤1/sec/cycle), delivered
    // to the cycle room we watch. It carries the same absolute totals as the
    // legacy per-bet bet_placed, so we normalise the field names and reuse the
    // exact same applier — no separate code path, no double logic.
    const handlePoolUpdate = (data: any) => {
      if (typeof data?.cycleId !== 'string' || !data.cycleId) return;
      handleBetPlaced({
        cycleId:        data.cycleId,
        cycleType:      data.cycleType,
        newTotalDelhi:  data.totalDelhi,
        newTotalBombay: data.totalBombay,
      });
    };

    const handleNewCycle = (data: any) => {
      // Server created a fresh cycle (sent 12s after cycle_result).
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
          realDelhi:       0,
          realBombay:      0,
          phantomDelhi:    0,
          phantomBombay:   0,
          phantomBalanced: false,
          winner:          undefined,
          declaredAt:      undefined,
        }
      }));
      // Switch our watch to the fresh cycle for this type (leaves the old one).
      syncWatched({ [ct]: data.cycleId });
    };

    const handleCycleResult = (data: any) => {
      const ct = toCycleType(data.type, data.cycleId);
      if (!ct) return;
      setCycles(prev => ({
        ...prev,
        [ct]: {
          ...prev[ct],
          winner:      data.winner as BettingSide,
          status:      GameState.RESULT_DECLARED,
          totalDelhi:  data.delhiPool  || data.totalDelhi  || prev[ct].totalDelhi,
          totalBombay: data.bombayPool || data.totalBombay || prev[ct].totalBombay,
          declaredAt:  Date.now()
        }
      }));
    };

    const handlePayoutComplete = (_data: any) => {
      // cycle_history pushed automatically by server after cycle_result — no action needed.
    };

    const handlePayoutSuccess = (data: any) => {
      if (data.winningsBalance !== undefined) {
        setUser(prev => {
          if (!prev) return null;
          const updated = {
            ...prev,
            winningsBalance: data.winningsBalance,
            depositBalance:  data.depositBalance  ?? prev.depositBalance,
            lockedBalance:   data.lockedBalance   ?? prev.lockedBalance,
          };
          updated.walletBalance = computeWalletBalance(updated);
          return updated;
        });
      }
      const amount = data.amount || data.payout || 0;
      if (amount > 0) {
        addToast(`🏆 You Won ₹${amount.toLocaleString()}! Winnings credited.`, 'success');
      }
    };

    const handleCyclePhase = (data: any) => {
      // cycle_phase does carry `type` (cycleGenerator emits it); the cycleId is
      // the fallback for older payloads.
      const ct = toCycleType(data.type, data.cycleId);
      if (!ct) return;
      setCycles(prev => ({ ...prev, [ct]: { ...prev[ct], status: data.phase as GameState } }));
    };

    const handleFireworks = (data: any) => {
      window.dispatchEvent(new CustomEvent('bazaar_fireworks', { detail: data }));
    };

    const handleCelebration = (data: any) => {
      window.dispatchEvent(new CustomEvent('bazaar_celebration', { detail: data }));
    };

    const handleUserBalanceUpdate = (data: any) => {
      setUser(prev => {
        if (!prev) return null;
        const updated = {
          ...prev,
          depositBalance:  data.depositBalance  ?? prev.depositBalance,
          winningsBalance: data.winningsBalance ?? prev.winningsBalance,
          lockedBalance:   data.lockedBalance   ?? prev.lockedBalance,
        };
        updated.walletBalance = computeWalletBalance(updated);
        return updated;
      });
    };

    const handleBrandingUpdated = (data: any) => {
      if (!data?.branding) return;
      const b = data.branding;
      localStorage.setItem('app_branding', JSON.stringify(b));
      // Inject CSS variables so every component using var(--brand-*) updates instantly
      const root = document.documentElement;
      if (b.primaryColor)   root.style.setProperty('--brand-primary',   b.primaryColor);
      if (b.secondaryColor) root.style.setProperty('--brand-secondary', b.secondaryColor);
      if (b.accentColor)    root.style.setProperty('--brand-accent',    b.accentColor);
      if (b.appName)        document.title = b.appName;
      window.dispatchEvent(new CustomEvent('branding_updated', { detail: b }));
    };

    // system_config: server pushes this on every connect and on request_system_config.
    // setSysConfig is the SINGLE writer of sysConfig state — single authority per GOVERNANCE.md.
    const handleSystemConfig = (data: any) => {
      if (!data) return;
      setSysConfig(prev => ({
        ...prev,
        minBet:        data.minBet        ?? prev.minBet,
        maxBet:        data.maxBet        ?? prev.maxBet,
        maxFullDayBet: data.maxFullDayBet  ?? prev.maxFullDayBet,
        minDeposit:    data.minDeposit    ?? prev.minDeposit,
        maxDeposit:    data.maxDeposit    ?? prev.maxDeposit,
        minWithdrawal: data.minWithdrawal ?? prev.minWithdrawal,
        maxWithdrawal: data.maxWithdrawal ?? prev.maxWithdrawal,
        tokenBuyRate:  data.tokenBuyRate  ?? prev.tokenBuyRate,
        tokenSellRate: data.tokenSellRate ?? prev.tokenSellRate,
        footerPages:   Array.isArray(data.footerPages) && data.footerPages.length ? data.footerPages : prev.footerPages,
      }));
    };

    // ── SSE subscriptions — public events (work for anonymous users too) ──────
    const unsubSSESnapshot    = onSSE('cycle_snapshot',   handleCycleSnapshot);
    const unsubSSEBetPlaced   = onSSE('bet_placed',       handleBetPlaced);
    const unsubSSENewCycle    = onSSE('new_cycle',        handleNewCycle);
    const unsubSSEResult      = onSSE('cycle_result',     handleCycleResult);
    const unsubSSEPhase       = onSSE('cycle_phase',      handleCyclePhase);
    const unsubSSEFireworks   = onSSE('fireworks',        handleFireworks);
    const unsubSSECelebration = onSSE('celebration',      handleCelebration);
    const unsubSSEBranding    = onSSE('branding_updated', handleBrandingUpdated);
    const unsubSSESysConfig   = onSSE('system_config',    handleSystemConfig);

    
    // Hand the live-pool stream between the two transports as the socket comes
    // and goes. Registered before the snapshot request below so a socket that
    // fails immediately still flips the latch.
    const handleSocketUp   = () => { socketFailed = false; syncSseCycles(); };
    const handleSocketDown = () => { socketFailed = true;  syncSseCycles(); };

    if (socket) {
      socket.on('cycle_snapshot', handleCycleSnapshot);
      socket.on('connect',        handleReconnect);
      socket.on('connect',        handleSocketUp);
      socket.on('disconnect',     handleSocketDown);
      socket.on('connect_error',  handleSocketDown);

      if (socket.connected) {
        socket.emit('request_cycle_snapshot');
      }
    }

    
    if (!socket) return () => {
      if (betPlacedFlushTimer != null) window.clearTimeout(betPlacedFlushTimer);
      unsubSSESnapshot(); unsubSSEBetPlaced(); unsubSSENewCycle();
      unsubSSEResult(); unsubSSEPhase(); unsubSSEFireworks();
      unsubSSECelebration(); unsubSSEBranding(); unsubSSESysConfig();
    };

    // WS: private per-user events + public fallback
    socket.on('payout_success',      handlePayoutSuccess);
    socket.on('payout_complete',     handlePayoutComplete);
    socket.on('user_balance_update', handleUserBalanceUpdate);
    // Admin adjust-balance emits 'user_update' (not 'user_balance_update').
    // Listen to both so admin wallet top-ups reflect instantly without refresh.
    socket.on('user_update',         handleUserBalanceUpdate);
    // No socket `bet_placed` listener: the server stopped emitting it globally
    // (2026-08-31). This client watches its cycle rooms and receives the
    // room-scoped `pool_update` below, which carries the same totals. The SSE
    // subscription above KEEPS listening to `bet_placed` — that is the only
    // live-pool path for a client whose WebSocket is blocked and which
    // therefore has no socket at all.
    socket.on('pool_update',         handlePoolUpdate);
    socket.on('new_cycle',           handleNewCycle);
    socket.on('cycle_result',        handleCycleResult);
    socket.on('cycle_phase',         handleCyclePhase);
    socket.on('fireworks',           handleFireworks);
    socket.on('celebration',         handleCelebration);
    socket.on('branding_updated',    handleBrandingUpdated);
    socket.on('system_config',       handleSystemConfig);

    return () => {
      if (betPlacedFlushTimer != null) window.clearTimeout(betPlacedFlushTimer);
      unsubSSESnapshot(); unsubSSEBetPlaced(); unsubSSENewCycle();
      unsubSSEResult(); unsubSSEPhase(); unsubSSEFireworks();
      unsubSSECelebration(); unsubSSEBranding(); unsubSSESysConfig();
      if (socket) {
        socket.off('cycle_snapshot',      handleCycleSnapshot);
        socket.off('connect',             handleReconnect);
        socket.off('connect',             handleSocketUp);
        socket.off('disconnect',          handleSocketDown);
        socket.off('connect_error',       handleSocketDown);
        socket.off('pool_update',         handlePoolUpdate);
        socket.off('new_cycle',           handleNewCycle);
        socket.off('cycle_result',        handleCycleResult);
        socket.off('payout_complete',     handlePayoutComplete);
        socket.off('payout_success',      handlePayoutSuccess);
        socket.off('cycle_phase',         handleCyclePhase);
        socket.off('fireworks',           handleFireworks);
        socket.off('celebration',         handleCelebration);
        socket.off('branding_updated',    handleBrandingUpdated);
        socket.off('system_config',       handleSystemConfig);
        socket.off('user_balance_update', handleUserBalanceUpdate);
        socket.off('user_update',         handleUserBalanceUpdate);
      }
    };
  }, [refreshCycles, currentUserId]);

  // ── PERSONAL WS EVENTS: apply server-pushed data directly, zero HTTP ─────
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
            const updated = {
              ...prev,
              depositBalance:  data.depositBalance  ?? prev.depositBalance,
              winningsBalance: data.winningsBalance ?? prev.winningsBalance,
              lockedBalance:   data.lockedBalance   ?? prev.lockedBalance,
            };
            updated.walletBalance = computeWalletBalance(updated);
            return updated;
          });
        }
        return;
      }
      
      if (data.depositBalance !== undefined || data.winningsBalance !== undefined) {
        setUser(prev => {
          if (!prev) return null;
          const updated = {
            ...prev,
            depositBalance:  data.depositBalance  ?? prev.depositBalance,
            winningsBalance: data.winningsBalance ?? prev.winningsBalance,
            lockedBalance:   data.lockedBalance   ?? prev.lockedBalance,
          };
          updated.walletBalance = computeWalletBalance(updated);
          return updated;
        });
      }
    });

    return () => { unsub(); };
  }, [user?.id]);

  // ── AUTH ──────────────────────────────────────────────────────────────────
  /**
   * Redeem a one-time bot link and adopt the session it grants.
   *
   * There is no password leg and no OTP leg any more: the bot proved the phone
   * number with a contact share and took the Aadhaar before it ever issued this
   * token, so by the time it arrives the only question left is whether the
   * token is still good. The server answers that, sets the httpOnly cookie, and
   * hands back the player — this just seats them.
   *
   * Throws on failure so the calling screen can show why; every failure reason
   * comes back as one message on purpose, and the fix is always a fresh /start.
   */
  const completeTelegramLogin = async (token: string): Promise<void> => {
    const res = await backend.exchangeTelegramToken(token);
    if (!res.success || !res.user) {
      throw new Error(res.message
        || 'This sign-in link is no longer valid. Send /start to the bot for a new one.');
    }
    const u = { ...res.user } as User;
    u.walletBalance = computeWalletBalance(u);
    setUser(u);
  };

  const logout = () => {
    setUser(null);
    setUserBets([]);
    setHistory([]);
    setIsGhostMode(false);   // FIX: ghost mode must be cleared on logout
    localStorage.removeItem('auth_token');
  };

  // ── BET PLACEMENT ─────────────────────────────────────────────────────────
  const placeBet = useCallback(async (amount: number, side: BettingSide) => {
    if (!user || isProcessingBet.current) return;

    // BUG-U6 fix: use dual balance for availability check
    // Architecture: deposit+winnings already decremented per bet; lockedBalance is a
    // separate tracking counter — do NOT subtract it here (would double-deduct).
    const availableBalance = (user.depositBalance || 0) + (user.winningsBalance || 0);
    if (availableBalance < amount) {
      addToast('Insufficient Balance', 'error');
      return;
    }

    isProcessingBet.current = true;
    try {
      const result = await backend.placeBet(user.id, cycles[cycleType].id, amount, side);

      // BUG-U4 fix: read result.balance.{deposit,winnings,locked} not result.newBalance
      setUser(prev => {
        if (!prev) return null;
        const updated = {
          ...prev,
          depositBalance:  result.balance?.deposit  ?? prev.depositBalance,
          winningsBalance: result.balance?.winnings ?? prev.winningsBalance,
          lockedBalance:   result.balance?.locked   ?? prev.lockedBalance,
        };
        updated.walletBalance = computeWalletBalance(updated);
        return updated;
      });

      setUserBets(prev => [result.bet, ...prev]);
    } catch (err: any) {
      addToast(err.message || 'Bet Failed', 'error');
    } finally { isProcessingBet.current = false; }
  }, [user, cycleType, cycles, addToast]);

  const placePhantomBet = useCallback(async (amount: number, side: BettingSide) => {
    if (!user) return;
    try {
      await backend.placePhantomBet(user.id, cycles[cycleType].id, amount, side);
    } catch (err: any) { addToast('Phantom Failed', 'error'); }
  }, [user, cycleType, cycles, addToast]);

  const updateProfile = async (updates: any) => {
    const updatedUser = await backend.updateUserProfile(user!.id, updates);
    setUser(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...updatedUser };
      updated.walletBalance = computeWalletBalance(updated);
      return updated;
    });
  };

  const triggerAdminAction = (action: string, payload?: any) => {
    const targetType = (payload?.targetType as CycleType) || cycleType;
    backend.manageCycle('ADMIN', action, { ...payload, cycleId: cycles[targetType].id });
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

  return (
    <GameContext.Provider value={{
      user, isAuthenticated: !!user, isOnline, completeTelegramLogin, logout,
      cycleType, setCycleType, cycles, currentCycle: cycles[cycleType],
      pastCycles, loadCycleHistory, gameState: cycles[cycleType].status, serverTimeOffset,
      placeBet, placePhantomBet, userBets, history, triggerAdminAction, formatTime,
      updateProfile, subscribeToVolume, getCurrentVolume, refreshUserWallet,
      isGhostMode,
    toggleGhostMode,
    sysConfig,
    }}>
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) throw new Error('useGame must be used within a GameProvider');
  return context;
};

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
  login: (mobile: string, pass: string) => Promise<boolean>;
  register: (username: string, mobile: string, pass: string, refCode?: string) => Promise<boolean>;
  logout: () => void;
  cycleType: CycleType;
  setCycleType: (type: CycleType) => void;
  isGhostMode: boolean;
  sysConfig: SysConfig;
  toggleGhostMode: () => void;
  cycles: { [key in CycleType]: GameCycle };
  currentCycle: GameCycle;
  pastCycles: GameCycle[];
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
  if (_refFromUrl) sessionStorage.setItem('referral_code', _refFromUrl);
}

export const GameProvider: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const { addToast } = useToast();
  const [user, setUser]             = useState<User | null>(null);
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
    [CycleType.THIRTY_MIN]: createNullCycle(CycleType.THIRTY_MIN),
    [CycleType.FULL_DAY]:   createNullCycle(CycleType.FULL_DAY),
  });

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

    const handleCycleHistory = (data: { cycles: any[] }) => {
      const resolved: GameCycle[] = (data.cycles || []).map((c: any) => ({
        ...c,
        totalDelhi:  c.totalDelhi  || c.delhiPool  || 0,
        totalBombay: c.totalBombay || c.bombayPool || 0,
      }));
      setPastCycles(resolved);
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

    // ── cycle_snapshot: authoritative init pushed by server on connect ───────
    // Arrives via SSE on every connection (SSE sends it on connect).
    
    const handleCycleSnapshot = (data: any) => {
      const map = data?.cycles || {};

      const applySnapshotType = (rawType: string, ct: CycleType) => {
        const c = map[rawType];
        if (!c) return;
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

      applySnapshotType('30_MIN',   CycleType.THIRTY_MIN);
      applySnapshotType('FULL_DAY', CycleType.FULL_DAY);
      setIsOnline(true);
    };

    // Request snapshot on every (re)connect so cycles are never stale after a
    // server restart or temporary network drop.
    const handleReconnect = () => {
      socket?.emit('request_cycle_snapshot');
    };

    // ── ALL HANDLERS DECLARED FIRST (avoids TDZ when minified) ──────────────
    // const/let are not hoisted like function declarations. Registering them with
    

    const pendingBetPlaced = new Map<CycleType, LiveStats>();
    let betPlacedFlushTimer: number | null = null;

    const flushBetPlaced = () => {
      const updates = Array.from(pendingBetPlaced.entries());
      pendingBetPlaced.clear();
      betPlacedFlushTimer = null;
      if (!updates.length) return;
      setCycles(prev => {
        const next = { ...prev };
        for (const [ct, stats] of updates) {
          next[ct] = { ...next[ct], totalDelhi: stats.totalDelhi, totalBombay: stats.totalBombay };
          liveStatsRef.current[ct] = stats;
        }
        return next;
      });
      for (const [ct] of updates) {
        subscribersRef.current.forEach(sub => { if (sub.type === ct) sub.cb(liveStatsRef.current[ct]); });
      }
    };

    const handleBetPlaced = (data: any) => {
      const ct = data.cycleType === '30_MIN' ? CycleType.THIRTY_MIN : CycleType.FULL_DAY;
      pendingBetPlaced.set(ct, {
        totalDelhi:  data.newTotalDelhi  || 0,
        totalBombay: data.newTotalBombay || 0,
      });
      if (betPlacedFlushTimer == null) {
        betPlacedFlushTimer = window.setTimeout(flushBetPlaced, 120);
      }
    };

    const handleNewCycle = (data: any) => {
      // Server created a fresh cycle (sent 12s after cycle_result).
      const ct = data.type === '30_MIN'
        ? CycleType.THIRTY_MIN
        : data.type === 'FULL_DAY'
          ? CycleType.FULL_DAY
          : data.cycleId?.includes('30MIN') ? CycleType.THIRTY_MIN : CycleType.FULL_DAY;
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
    };

    const handleCycleResult = (data: any) => {
      const rawType = data.type;
      const ct = rawType === '30_MIN'
        ? CycleType.THIRTY_MIN
        : rawType === 'FULL_DAY'
          ? CycleType.FULL_DAY
          : data.cycleId?.includes('30MIN') ? CycleType.THIRTY_MIN : CycleType.FULL_DAY;
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
      const ct = data.cycleId?.includes('30MIN') ? CycleType.THIRTY_MIN : CycleType.FULL_DAY;
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

    
    if (socket) {
      socket.on('cycle_snapshot', handleCycleSnapshot);
      socket.on('connect',        handleReconnect);
      
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
    socket.on('bet_placed',          handleBetPlaced);
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
        socket.off('bet_placed',          handleBetPlaced);
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
  const login = async (mobile: string, pass: string) => {
    try {
      const res = await backend.login({ mobile, password: pass });
      if (res.success) {
        // BUG-U6 fix: compute walletBalance on login
        const u = { ...res.user };
        u.walletBalance = computeWalletBalance(u);
        setUser(u);
        return true;
      }
      throw new Error((res as any).message || 'Invalid credentials. Please check your mobile and password.');
    } catch (e: any) { throw e; }
  };

  const register = async (username: string, mobile: string, pass: string, refCode?: string) => {
    try {
      const storedRef = refCode || sessionStorage.getItem('referral_code') || undefined;
      const res = await backend.register({ username, mobile, password: pass, referralCode: storedRef });
      if (res.success) sessionStorage.removeItem('referral_code');
      if (res.success) {
        const u = { ...res.user };
        u.walletBalance = computeWalletBalance(u);
        setUser(u);
        return true;
      }
      throw new Error((res as any).message || 'Registration failed. Mobile may already be registered.');
    } catch (e: any) { throw e; }
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
      user, isAuthenticated: !!user, isOnline, login, register, logout,
      cycleType, setCycleType, cycles, currentCycle: cycles[cycleType],
      pastCycles, gameState: cycles[cycleType].status, serverTimeOffset,
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

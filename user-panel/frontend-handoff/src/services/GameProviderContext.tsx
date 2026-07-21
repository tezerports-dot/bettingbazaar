/**
 * GameProviderContext.tsx
 *
 * Fetches provider availability from /api/game/providers on app mount.
 * Components consume this to know which sections are live.
 * Footer reads from this — tabs only appear when admin has enabled a provider.
 *
 * Cached in sessionStorage so subsequent renders don't re-fetch.
 */
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { createContext, useContext, useEffect, useState } from 'react';

interface Provider {
  key: string;
  name: string;
  enabled: boolean;
  description: string;
  logoUrl: string;
}

interface ProviderGroups {
  casino:  Provider[];
  crash:   Provider[];
  sports:  Provider[];
  slots?:  Provider[];
}

interface GameProviderCtx {
  providers:     ProviderGroups;
  loading:       boolean;
  anyCasino:     boolean;
  anyCrash:      boolean;
  anySports:     boolean;
  enabledCasino: Provider[];
  enabledCrash:  Provider[];
  enabledSports: Provider[];
  refresh:       () => void;
}

const defaultCtx: GameProviderCtx = {
  providers:     { casino: [], crash: [], sports: [] },
  loading:       true,
  anyCasino:     false,
  anyCrash:      false,
  anySports:     false,
  enabledCasino: [],
  enabledCrash:  [],
  enabledSports: [],
  refresh:       () => {},
};

const Ctx = createContext<GameProviderCtx>(defaultCtx);

export const GameProviderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [providers, setProviders] = useState<ProviderGroups>({ casino: [], crash: [], sports: [] });
  const [loading, setLoading]     = useState(true);

  const fetch = async () => {
    try {
      // Check session cache first
      // M-02: 5-minute TTL — branding changes take up to 5 min to reflect in game provider list.
      // GOVERNANCE §5: config cached client-side must document staleness window here.
      const cached = sessionStorage.getItem('_gp_cache');
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < 5 * 60 * 1000) { setProviders(data); setLoading(false); return; }
      }
      const r = await window.fetch('/api/game/providers');
      const d = await r.json();
      if (d.success) {
        const data: ProviderGroups = d.providers || { casino: [], crash: [], sports: [] };
        setProviders(data);
        sessionStorage.setItem('_gp_cache', JSON.stringify({ data, ts: Date.now() }));
      }
    } catch (e) { console.warn('[GameProviderContext] Provider fetch failed:', e instanceof Error ? e.message : e); } // LOW-04
    finally { setLoading(false); }
  };

  useEffect(() => { fetch(); }, []);

  const enabledCasino = providers.casino?.filter(p => p.enabled) || [];
  const enabledCrash  = providers.crash?.filter(p => p.enabled)  || [];
  const enabledSports = providers.sports?.filter(p => p.enabled) || [];

  return (
    <Ctx.Provider value={{
      providers, loading,
      anyCasino:  enabledCasino.length > 0,
      anyCrash:   enabledCrash.length  > 0,
      anySports:  enabledSports.length > 0,
      enabledCasino, enabledCrash, enabledSports,
      refresh: () => { sessionStorage.removeItem('_gp_cache'); fetch(); },
    }}>
      {children}
    </Ctx.Provider>
  );
};

export const useGameProviders = () => useContext(Ctx);

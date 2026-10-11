// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant account, as GET /api/merchant/account answers it: its pool and
 * commission, payment accounts, flags, and (owner) sub-members and pool
 * requests (owner, 2026-10-11). One read every account screen shares; each
 * write reloads it, so a screen shows the rows, never a copy patched here.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { MerchantAccountOverview } from '../types';

/** `enabled` false (not a merchant-account session): nothing is asked, and nothing is loaded. */
export function useMerchantAccount(enabled = true) {
  const [overview, setOverview] = useState<MerchantAccountOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const next = await api.getMerchantAccount();
      setOverview(next);
      setError('');
      setState('ready');
    } catch (err: any) {
      // The server's own words (403 NOT_A_MERCHANT_ACCOUNT says what to do).
      setError(err?.message || 'Could not load the merchant account.');
      setState('error');
    }
  }, []);

  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);

  return { overview, state, error, reload };
}

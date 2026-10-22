// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ladderSettings.ts — the one set of ladder inputs the progression calculator
 * and the Auto bets sheet both edit, per profile (owner, 2026-10-22: the auto
 * bets "synced with progression calculator"). Typing a starting bet in one
 * shows it in the other; VIP and General keep their own.
 *
 * UI state only (§11): the server checks every value again when a plan is
 * started (backend/domains/markets/autoBets.js). Kept in this browser between
 * visits as a convenience; a blocked or empty storage just starts from the
 * defaults.
 */
import { useEffect, useState } from 'react';
import type { Side } from './analytics';

export type Audience = 'VIP' | 'GENERAL';

/** Typed text, so a field can be cleared while typing; parsed where it is used. */
export interface LadderSettings {
  start: string;
  factor: string;
  steps: string;
  side: Side;
  stopLoss: string;
  takeProfit: string;
  budget: string;
}

const DEFAULTS: LadderSettings = {
  start: '10', factor: '3', steps: '5', side: 'DELHI', stopLoss: '', takeProfit: '', budget: '',
};

const KEY = (a: Audience) => `bb_ladder_${a}`;

function load(a: Audience): LadderSettings {
  try {
    const raw = localStorage.getItem(KEY(a));
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof LadderSettings)[]) {
      if (typeof v?.[k] === 'string') (out as any)[k] = v[k];
    }
    if (out.side !== 'DELHI' && out.side !== 'BOMBAY') out.side = 'DELHI';
    return out;
  } catch { return { ...DEFAULTS }; }
}

const current: Partial<Record<Audience, LadderSettings>> = {};
const listeners = new Set<() => void>();

function read(a: Audience): LadderSettings {
  if (!current[a]) current[a] = load(a);
  return current[a] as LadderSettings;
}

export function updateLadderSettings(a: Audience, patch: Partial<LadderSettings>): void {
  current[a] = { ...read(a), ...patch };
  try { localStorage.setItem(KEY(a), JSON.stringify(current[a])); } catch { /* kept for this visit only */ }
  listeners.forEach((l) => l());
}

/** The profile's ladder inputs and a setter; every user of the hook sees each change. */
export function useLadderSettings(a: Audience): [LadderSettings, (patch: Partial<LadderSettings>) => void] {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return [read(a), (patch) => updateLadderSettings(a, patch)];
}

/** Parses a typed number; '' and junk are null. */
export const num = (v: string): number | null => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Demo results in the analytics (owner, 2026-10-15; the rules are
 * backend/domains/markets/demoResults.js).
 *
 * A board's analytics window is 1,440 results. While it holds fewer real
 * ones, the rest of the window is demo results placed BEFORE the oldest real
 * one: real first (newest), then demo #1, #2, … going back. Each real result
 * that arrives pushes the oldest demo out; with a full window none is shown.
 *
 * Demo winners are drawn from the board's key and the demo's number alone, so
 * every player sees the same demo history and demo #n never changes. Display
 * only (§11): never in the Results list, never a cycle, never sent anywhere.
 *
 * Or the admin types them (owner, 2026-10-20): Admin › Boards › Demo
 * results, per board and profile, sent with the board as `demoResults`
 * (B and D, OLDEST first). A board and profile with typed results shows
 * those, newest typed result just before the oldest real one, and no drawn
 * ones; with none typed, the drawn ones as before. Either way they are drawn
 * the same way, faded.
 *
 * Whether they are on is the server's (`SystemConfig.demoResultsOn`, sent by
 * systemConfigPayload.js); the panel keeps no copy, and shows no demo result
 * until that has arrived. They are drawn faded (`DEMO_STYLE`) and named
 * nowhere on screen; the board rules say the results include demo ones
 * (owner, 2026-10-15).
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import type { Side } from './analytics';
import { getBackend } from '../services/backend.service';

/** 32-bit FNV-1a, then a final mix, so neighbouring numbers are unrelated. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Demo winners #1..#count for a board, newest (#1, just before the oldest real) first. */
export function demoWinners(boardKey: string, count: number): Side[] {
  const out: Side[] = [];
  for (let n = 1; n <= count; n++) out.push(hash(`${boardKey}|demo|${n}`) & 1 ? 'DELHI' : 'BOMBAY');
  return out;
}

/** The admin's typed results ('B'/'D', oldest first), newest first as the analytics read them. */
export function typedDemoWinners(typed: string, count: number): Side[] {
  const out: Side[] = [];
  for (let i = typed.length - 1; i >= 0 && out.length < count; i--) out.push(typed[i] === 'D' ? 'DELHI' : 'BOMBAY');
  return out;
}

/**
 * The window to analyse: the real winners, then as many demo winners as fill
 * it to `window` (the admin's typed ones when there are any, else drawn).
 * `real` is how many of the returned winners are real.
 */
export function withDemoResults(realNewestFirst: Side[], boardKey: string, window: number, on: boolean, typed = ''): { winners: Side[]; real: number } {
  const real = Math.min(realNewestFirst.length, window);
  const fill = on && boardKey ? Math.max(0, window - real) : 0;
  if (!fill) return { winners: realNewestFirst.slice(0, real), real };
  const demo = typed ? typedDemoWinners(typed, fill) : demoWinners(boardKey, fill);
  return { winners: [...realNewestFirst.slice(0, real), ...demo], real };
}

export interface DemoResultsConfig { on: boolean }

/** The server's demo settings; null until they have arrived (no demo is shown before). */
export function useDemoResults(): DemoResultsConfig | null {
  const [cfg, setCfg] = useState<DemoResultsConfig | null>(null);
  useEffect(() => {
    let live = true;
    getBackend().getSystemConfig()
      .then((c) => {
        if (!live || typeof c.demoResultsOn !== 'boolean') return;
        setCfg({ on: c.demoResultsOn });
      })
      .catch(() => { /* no demo results until the config arrives */ });
    return () => { live = false; };
  }, []);
  return cfg;
}

/** How a demo bead or box is drawn: a light fade, nothing more (owner, 2026-10-22: quieter). */
export const DEMO_STYLE: React.CSSProperties = { opacity: 0.6 };

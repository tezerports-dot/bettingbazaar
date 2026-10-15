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
 * Whether they are on and the line shown with them are the server's
 * (`SystemConfig.demoResultsOn`, `demoResultsLabel`, sent never blank by
 * systemConfigPayload.js); the panel keeps no copy, and shows no demo result
 * until that has arrived.
 */
import React, { useEffect, useState } from 'react';
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

/**
 * The window to analyse: the real winners, then as many demo winners as fill
 * it to `window`. `real` is how many of the returned winners are real.
 */
export function withDemoResults(realNewestFirst: Side[], boardKey: string, window: number, on: boolean): { winners: Side[]; real: number } {
  const real = Math.min(realNewestFirst.length, window);
  const fill = on && boardKey ? Math.max(0, window - real) : 0;
  return { winners: fill ? [...realNewestFirst.slice(0, real), ...demoWinners(boardKey, fill)] : realNewestFirst.slice(0, real), real };
}

export interface DemoResultsConfig { on: boolean; label: string }

/** The server's demo settings; null until they have arrived (no demo is shown before). */
export function useDemoResults(): DemoResultsConfig | null {
  const [cfg, setCfg] = useState<DemoResultsConfig | null>(null);
  useEffect(() => {
    let live = true;
    getBackend().getSystemConfig()
      .then((c) => {
        if (!live || typeof c.demoResultsLabel !== 'string' || !c.demoResultsLabel) return;
        setCfg({ on: c.demoResultsOn === true, label: c.demoResultsLabel });
      })
      .catch(() => { /* no demo results until the config arrives */ });
    return () => { live = false; };
  }, []);
  return cfg;
}

/** The line shown wherever demo results are in the window. */
export const DemoResultsNote: React.FC<{ label: string; demo: number }> = ({ label, demo }) => (
  <p role="note" data-testid="demo-results-note" style={{ margin: '0 0 10px', padding: '8px 12px', borderRadius: 10, border: '1px dashed var(--line2)', background: 'var(--surface2)', fontSize: 11, lineHeight: 1.5, color: 'var(--text2)' }}>
    ⓘ {label} <b style={{ color: 'var(--text)' }}>({demo.toLocaleString('en-IN')} demo)</b>
  </p>
);

/** How a demo bead or box is drawn: faded, with a dashed edge. */
export const DEMO_STYLE: React.CSSProperties = { opacity: 0.45, outline: '1px dashed rgba(255,255,255,.55)', outlineOffset: -2 };

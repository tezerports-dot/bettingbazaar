// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Where a pool's tokens are (owner, 2026-10-14).
 *
 * A merchant could see one "available" figure and, at most, a "held" total:
 * nothing said how much was locked in open orders, how much waited on a
 * dispute, or what their sells were about to add. Every figure here is the
 * server's (`teamPools.poolExposureSql`, read per team and per member), drawn
 * the same way on the Dashboard, the Team page and a merchant account's Pool
 * page so the three never disagree.
 */
import React from 'react';
import { formatTokens } from '../utils/rail';
import type { PoolExposure } from '../types';

const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);

export interface PoolTile { label: string; value: string; hint: string; tone?: string }

/** The tiles, in the order a merchant reads them: what is free, what is locked, what is coming. */
export function poolTiles(exposure: PoolExposure, availablePaise?: number | null): PoolTile[] {
  const tiles: PoolTile[] = [];
  if (availablePaise !== undefined && availablePaise !== null) {
    tiles.push({ label: 'Available', value: tokensOf(availablePaise), hint: 'Free for new buy orders', tone: 'var(--dep)' });
  }
  tiles.push(
    {
      label: 'Locked in open buys', value: tokensOf(exposure.heldOpenPaise),
      hint: `${exposure.openBuys} open buy order${exposure.openBuys === 1 ? '' : 's'}; paid out when each completes`,
    },
    {
      // One tile for every dispute, buy or sell (owner, 2026-10-22).
      label: 'Locked in disputes', value: tokensOf(exposure.heldDisputedPaise + exposure.sellsDisputedPaise),
      hint: 'Buys and sells in dispute or rejected as unpaid; released or paid when an admin decides',
      tone: exposure.heldDisputedPaise + exposure.sellsDisputedPaise > 0 ? 'var(--warn)' : undefined,
    },
    {
      label: 'Incoming from sells', value: tokensOf(exposure.sellsSettlingPaise),
      hint: 'Sells you marked paid; added to the pool when the hold window ends',
    },
  );
  return tiles;
}

export const PoolBreakdown: React.FC<{
  exposure: PoolExposure | undefined | null;
  /** The pool's free tokens, when this view is of a pool (not one member's orders). */
  availablePaise?: number | null;
}> = ({ exposure, availablePaise }) => {
  if (!exposure) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
      {poolTiles(exposure, availablePaise).map((tile) => (
        <div key={tile.label} style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{tile.label}</div>
          <div className="bb-mono" style={{ fontSize: 16, fontWeight: 800, color: tile.tone ?? 'var(--text)', marginTop: 3 }}>{tile.value}</div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.35 }}>{tile.hint}</div>
        </div>
      ))}
    </div>
  );
};

export default PoolBreakdown;

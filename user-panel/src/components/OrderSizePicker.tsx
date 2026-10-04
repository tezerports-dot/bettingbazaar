// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order sizes a player may buy or sell, as tiles grouped by rail.
 *
 * ── The owner's rule (PROJECT_STATUS §3.10, Step 2d) ─────────────────────────
 * An INR order is exactly one of a fixed list of sizes, the same for buys and
 * sells, and the size decides the rail: the small sizes go to a cash team, the
 * large ones to a UPI/bank team. So a player picks a size, never types one, and
 * the tile they pick says which rail it is on.
 *
 * ── Every size comes from the server ───────────────────────────────────────
 * `sizes` is `GET /api/v1/system/config`'s `orderSizes`, built from the same
 * module and row the risk gate judges by (backend/domains/merchant/
 * denominations.js, via systemConfigPayload.js). Nothing here is a list of
 * sizes: the app ships as an APK containing this bundle, so a list written here
 * is one an attacker can edit and one that drifts from the gate.
 *
 * ── `maxAllowed` ───────────────────────────────────────────────────────────
 * A sell can only draw on winnings, so a size above them is shown but disabled,
 * with the sentence under the tiles saying why. Display only: the server
 * refuses it either way, and that refusal is what the player is told if the
 * balance moved since this screen loaded.
 */
import React from 'react';

/** The rails a size can be on — the keys of the server's `orderSizes`. */
export type SizeRail = 'CASH' | 'UPI_BANK';

export interface OrderSizes { CASH: number[]; UPI_BANK: number[] }

const RAIL_LABEL: Record<SizeRail, string> = {
  CASH: 'Cash team',
  UPI_BANK: 'UPI / bank team',
};

interface Props {
  /** Prefix for element ids, so a buy and a sell picker can share a page. */
  idPrefix: string;
  sizes: OrderSizes;
  value: number | null;
  onChange: (size: number) => void;
  /** Sizes above this are disabled (a sell beyond winnings). */
  maxAllowed?: number;
  /** The accent for a chosen tile. */
  accent?: string;
}

const fmt = (n: number) => n.toLocaleString('en-IN');

export default function OrderSizePicker({
  idPrefix, sizes, value, onChange, maxAllowed, accent = 'var(--gold)',
}: Props) {
  const rails = (['CASH', 'UPI_BANK'] as SizeRail[]).filter((r) => sizes[r].length > 0);
  if (rails.length === 0) {
    // The admin has every size off (the save refuses that, so this is a
    // config row nobody could have written through the screen) or the config
    // has not loaded. Said, not left as an empty box (§32 S21).
    return (
      <p role="status" style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 12px' }}>
        No order sizes are on offer right now.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
      {rails.map((rail) => {
        const labelId = `${idPrefix}-${rail.toLowerCase()}`;
        return (
          <div key={rail}>
            <div id={labelId} style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
              {RAIL_LABEL[rail]}
            </div>
            <div role="radiogroup" aria-labelledby={labelId}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
              {sizes[rail].map((size) => {
                const on = value === size;
                const blocked = maxAllowed !== undefined && size > maxAllowed;
                return (
                  <button
                    key={size} type="button" role="radio" aria-checked={on}
                    aria-label={`${fmt(size)} tokens`}
                    disabled={blocked}
                    onClick={() => onChange(size)}
                    className="font-grotesk"
                    style={{
                      padding: '13px 8px', borderRadius: 12, fontWeight: 800, fontSize: 15,
                      cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.4 : 1,
                      border: on ? `2px solid ${accent}` : '1px solid var(--line)',
                      background: on ? 'var(--gold-soft, rgba(var(--brand-primary-rgb), .12))' : 'transparent',
                      color: on ? 'var(--text)' : 'var(--text2)',
                    }}
                  >
                    {fmt(size)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Which rail the server's list puts a size on, or null if it is not offered. */
export function railOfSize(sizes: OrderSizes, size: number | null): SizeRail | null {
  if (size === null) return null;
  if (sizes.CASH.includes(size)) return 'CASH';
  if (sizes.UPI_BANK.includes(size)) return 'UPI_BANK';
  return null;
}

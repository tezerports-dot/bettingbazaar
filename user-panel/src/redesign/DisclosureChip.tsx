// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A disclosure drawn as a small chip (owner, 2026-10-15: the full lines took
 * too much space). The chip is always on screen beside the figure it is about;
 * tapping it shows the admin's full line under it, tapping again hides it.
 * The full line is the server's (house bets, demo results); the chip's short
 * text is the panel's (§11, display only). With no line from the server the
 * figure it qualifies is not shown either (the callers draw nothing before
 * the config arrives), so the chip has nothing to hide.
 */
import React, { useId, useState } from 'react';

export const DisclosureChip: React.FC<{ short: string; label: string; testId?: string; style?: React.CSSProperties }> = ({ short, label, testId, style }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!label) return null;
  return (
    <span data-testid={testId} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', verticalAlign: 'middle', ...style }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        title={label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 7px', borderRadius: 999,
          border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text2)',
          fontSize: 10, fontWeight: 700, lineHeight: 1.5, whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        ⓘ {short}
      </button>
      {open && (
        <span id={id} role="note" style={{ marginTop: 4, maxWidth: 260, fontSize: 10, lineHeight: 1.45, color: 'var(--text3)', textAlign: 'center' }}>
          {label}
        </span>
      )}
    </span>
  );
};

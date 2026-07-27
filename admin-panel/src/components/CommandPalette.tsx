// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// ⌘K / Ctrl-K command palette — jump to any page the current admin can see.
// Presentational: the visible nav model + navigate handler come from Layout.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, type LucideIcon } from 'lucide-react';

export interface PaletteItem {
  label: string;
  path: string;
  group: string;
  Icon: LucideIcon;
}

interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  onNavigate: (path: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, items, onClose, onNavigate }) => {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      // Focus the field once the palette mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const matched = items.filter(
      (it) => !query || it.label.toLowerCase().includes(query) || it.group.toLowerCase().includes(query)
    );
    const byGroup: Record<string, PaletteItem[]> = {};
    for (const it of matched) (byGroup[it.group] ||= []).push(it);
    return Object.entries(byGroup);
  }, [items, query]);

  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);

  if (!open) return null;

  const go = (path: string) => {
    onNavigate(path);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      className="om-fade"
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'var(--overlay)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', paddingTop: '11vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="om-pop"
        style={{
          width: 600, maxWidth: '92vw', maxHeight: '70vh', background: 'var(--surface)',
          border: '1px solid var(--border-2)', borderRadius: 16, boxShadow: 'var(--sh3)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
          <Search size={18} style={{ color: 'var(--muted)', flex: 'none' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && flat[0]) go(flat[0].path);
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Jump to page…"
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 15, outline: 'none' }}
          />
          <span style={{
            fontSize: 10.5, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", padding: '3px 7px',
            borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--muted)',
          }}>ESC</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {groups.map(([label, list]) => (
            <div key={label}>
              <div style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.12em', textTransform: 'uppercase', padding: '10px 12px 5px' }}>
                {label}
              </div>
              {list.map((it) => (
                <div
                  key={it.path}
                  onClick={() => go(it.path)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 9, cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <it.Icon size={16} style={{ color: 'var(--text-2)', flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{it.label}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{it.group}</span>
                </div>
              ))}
            </div>
          ))}
          {query && flat.length === 0 && (
            <div style={{ padding: 34, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
              No matches for “{q}”
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;

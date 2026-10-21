// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Install app" (owner, 2026-10-21): in the browser only. A tap shows the
 * browser's own install prompt; on an iPhone or iPad it says how Safari does
 * it. Nothing is drawn once the panel is installed (services/installPrompt.ts).
 */
import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { installState, onInstallStateChange, promptInstall, type InstallState } from '../services/installPrompt';

const InstallAppButton: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const [state, setState] = useState<InstallState>(() => installState());
  const [iosHelp, setIosHelp] = useState(false);
  useEffect(() => onInstallStateChange(() => setState(installState())), []);

  if (state === 'none') return null;

  const press = async () => {
    if (state === 'ios') { setIosHelp((v) => !v); return; }
    await promptInstall();
    setState(installState());
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => void press()}
        aria-expanded={state === 'ios' ? iosHelp : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10,
          border: '1.5px solid var(--brand)', background: 'var(--brand-bg)', color: 'var(--brand)',
          fontSize: 12.5, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <Download size={15} aria-hidden /> Install app
      </button>
      {state === 'ios' && iosHelp && (
        <p role="status" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, width: 230, margin: 0,
          padding: '10px 12px', borderRadius: 10, background: 'var(--elev)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)',
        }}>
          In Safari, tap the Share button, then <strong>Add to Home Screen</strong>.
        </p>
      )}
    </div>
  );
};

export default InstallAppButton;

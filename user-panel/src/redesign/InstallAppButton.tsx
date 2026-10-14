// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Install app" (owner, 2026-10-14: "a button … where user can click to
 * install the PWA"). Shown only where installing is possible: a tap shows the
 * browser's own prompt; on an iPhone or iPad it says how Safari does it.
 * Nothing is shown once installed or inside the Android app (installPrompt.ts).
 */
import React, { useEffect, useState } from 'react';
import { installState, onInstallStateChange, promptInstall, type InstallState } from '../services/installPrompt';

const BUTTON: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  padding: 10, borderRadius: 12, border: '1px solid var(--line2)', cursor: 'pointer',
  background: 'color-mix(in srgb,var(--gold) 8%,transparent)', color: 'var(--gold-ink)',
  fontWeight: 800, fontSize: 12,
};

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
    <div style={style}>
      <button type="button" onClick={press} aria-expanded={state === 'ios' ? iosHelp : undefined} style={BUTTON}>
        <span aria-hidden="true">📲</span>Install app
      </button>
      {state === 'ios' && iosHelp && (
        <p role="status" style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--text2)', textAlign: 'center' }}>
          In Safari, tap the Share button, then <strong>Add to Home Screen</strong>.
        </p>
      )}
    </div>
  );
};

export default InstallAppButton;

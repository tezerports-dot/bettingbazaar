// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The ten recovery codes, shown once, with Copy and Download. One component for
 * both places that show them (the first sign-in, and My Authenticator after a
 * regenerate), so the two never word or lay them out differently (§5).
 */
import React from 'react';
import { Copy, Download } from 'lucide-react';
import toast from 'react-hot-toast';

const secondaryButton: React.CSSProperties = {
  flex: 1, height: 38, borderRadius: 9, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};

/** What Copy and Download hand over: the codes and what they are for. */
const recoveryCodesText = (codes: string[], appName: string, mobile?: string): string =>
  [`${appName} recovery codes`, ...(mobile ? [`Mobile: ${mobile}`] : []), '', ...codes, '',
    'Each code works once, in place of an authenticator code.'].join('\n');

export const RecoveryCodes: React.FC<{ codes: string[]; appName: string; mobile?: string }> = ({ codes, appName, mobile }) => {
  const text = recoveryCodesText(codes, appName, mobile);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy. Download them instead, or write them down.');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <ol
        aria-label="Recovery codes"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 18px', listStyle: 'none', padding: '12px 14px', margin: '0 0 12px', borderRadius: 10, border: '1px solid var(--border)', fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700 }}
      >
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button type="button" onClick={copy} style={secondaryButton}><Copy size={14} /> Copy</button>
        <button type="button" onClick={download} style={secondaryButton}><Download size={14} /> Download</button>
      </div>
    </>
  );
};

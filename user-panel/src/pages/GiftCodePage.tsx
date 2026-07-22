// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GiftCodePage.tsx — 2026 "Bazaar" redesign. Redeem a promo code
 * (POST /api/giftcode/redeem). Logic unchanged; presentation rebuilt on theme.
 */
import React, { useState } from 'react';
import { fmt } from '../redesign/format';
import ScreenShell, { goldButton } from '../redesign/Screen';

export default function GiftCodePage() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const redeem = async () => {
    if (!code.trim()) return;
    setLoading(true); setResult(null);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/giftcode/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.toUpperCase().trim() }),
      });
      const d = await r.json();
      setResult(d);
      if (d.success) setCode('');
    } catch { setResult({ success: false, message: 'Could not redeem right now. Try again.' }); }
    finally { setLoading(false); }
  };

  return (
    <ScreenShell icon="🎁" title="Gift Code" sub="Redeem a promo code">
      <div style={{ maxWidth: 460, margin: '0 auto', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 18, padding: 22, boxShadow: 'var(--shadow)', textAlign: 'center' }}>
        <span style={{ fontSize: 40 }}>🎁</span>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)', margin: '8px 0 4px' }}>Redeem a gift code</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 18 }}>Enter a promo code to instantly credit your bonus balance.</div>
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') redeem(); }} placeholder="ENTER CODE" className="font-grotesk" style={{ width: '100%', height: 52, textAlign: 'center', background: 'var(--surface2)', border: '1px dashed var(--line2)', borderRadius: 13, color: 'var(--text)', fontSize: 18, fontWeight: 700, letterSpacing: '.22em', textTransform: 'uppercase', outline: 'none', marginBottom: 13 }} />
        <button onClick={redeem} disabled={loading || !code.trim()} style={{ ...goldButton, opacity: (loading || !code.trim()) ? .5 : 1 }}>{loading ? 'Checking…' : 'Redeem code'}</button>

        {result && (
          <div style={{ marginTop: 14, padding: 14, borderRadius: 13, border: `1px solid ${result.success ? 'color-mix(in srgb,var(--green) 40%,transparent)' : 'color-mix(in srgb,var(--red) 40%,transparent)'}`, background: result.success ? 'color-mix(in srgb,var(--green) 10%,transparent)' : 'color-mix(in srgb,var(--red) 10%,transparent)' }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>{result.success ? '🎉' : '❌'}</div>
            <p style={{ fontWeight: 800, fontSize: 13, color: result.success ? 'var(--green)' : 'var(--red)', margin: 0 }}>{result.message}</p>
            {result.success && result.amount && <p style={{ color: 'var(--text)', fontSize: 12, marginTop: 4 }}>₹{fmt(result.amount)} added to your balance!</p>}
          </div>
        )}

        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 14, lineHeight: 1.5 }}>Codes are single-use. Follow our Telegram for weekly drops.</div>
      </div>
    </ScreenShell>
  );
}

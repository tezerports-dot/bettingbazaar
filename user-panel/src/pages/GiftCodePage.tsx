// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GiftCodePage.tsx — redeem a promo code, and see what you have been credited.
 *
 * The history half was missing. GET /api/bonuses/my has always paged a player's
 * own bonus records and nothing called it, so after redeeming a code the only
 * confirmation was the toast that had already gone: a player could not check
 * whether a credit had actually landed, and had to ask support.
 *
 * It also closes the loop on the admin side. The gift-code screen now surfaces
 * redemptions with no matching ledger credit — money owed — and this is where
 * the player sees the same fact from their end.
 */
import React, { useEffect, useState } from 'react';
import { fmt } from '../redesign/format';
import ScreenShell, { goldButton } from '../redesign/Screen';
import { apiUrl } from '../services/apiUrl';

export default function GiftCodePage() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [bonuses, setBonuses] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch(apiUrl('/api/bonuses/my?limit=30'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (d?.success) setBonuses(d.records || []);
    } catch { /* the section renders its empty state */ }
    finally { setHistoryLoading(false); }
  };

  useEffect(() => { loadHistory(); }, []);

  const redeem = async () => {
    if (!code.trim()) return;
    setLoading(true); setResult(null);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch(apiUrl('/api/giftcode/redeem'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.toUpperCase().trim() }),
      });
      const d = await r.json();
      setResult(d);
      // Re-read rather than pushing the optimistic amount onto the list: the
      // record is written server-side, and showing a credit the server has not
      // confirmed is exactly the reassurance a player should not be given.
      if (d.success) { setCode(''); loadHistory(); }
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

      <div style={{ maxWidth: 460, margin: '18px auto 0', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 18, padding: 22, boxShadow: 'var(--shadow)' }}>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 4 }}>Your bonuses</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14 }}>Every bonus credited to your account.</div>

        {historyLoading ? (
          <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: '18px 0' }}>Loading…</div>
        ) : bonuses.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: '18px 0' }}>
            No bonuses yet. Redeem a code above to get started.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {bonuses.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: 'var(--surface2)', borderRadius: 12, padding: '10px 13px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{b.description || b.type}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>{new Date(b.createdAt).toLocaleString('en-IN')}</div>
                </div>
                <div className="font-grotesk" style={{ fontSize: 14, fontWeight: 800, color: 'var(--green)', whiteSpace: 'nowrap' }}>+₹{fmt(b.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

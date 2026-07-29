// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * TwoFactorEnrol — merchant TOTP enrolment.
 *
 * 2FA is MANDATORY for merchants: the account settles real INR and USDT, so
 * brute-forcing it attacks the settlement rail rather than one player's
 * balance. Existing merchants are not locked out on deploy day — the backend
 * issues a session flagged `mustEnroll2FA` and the panel routes them here.
 *
 * There is deliberately no "disable" control, matching the backend: the
 * merchant 2FA router has no /disable endpoint, so offering a button that
 * cannot work would be worse than offering none.
 *
 * The QR is drawn from the bundled `qrcode` package rather than a CDN — the
 * platform CSP is script-src 'self', so a CDN-hosted library would be blocked
 * and this screen would silently render an empty box.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import toast from 'react-hot-toast';
import { api } from '../services/api';

type Stage = 'loading' | 'idle' | 'scanning' | 'codes' | 'active';

export default function TwoFactorEnrol() {
  const [stage, setStage] = useState<Stage>('loading');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.twoFactorStatus()
      .then((r) => setStage(r?.enabled ? 'active' : 'idle'))
      .catch(() => setStage('idle'));
  }, []);

  const begin = async () => {
    setBusy(true);
    try {
      const r = await api.twoFactorSetup();
      setSecret(r.secret);
      // Fixed black-on-white: scanners cope badly with themed or inverted
      // codes, and a QR that will not scan is a support ticket.
      setQr(await QRCode.toDataURL(r.otpauthUri, {
        width: 208, margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      }));
      setStage('scanning');
    } catch (e: any) {
      toast.error(e?.message || 'Could not start setup');
    } finally { setBusy(false); }
  };

  const activate = async () => {
    setBusy(true);
    try {
      const r = await api.twoFactorActivate(code.trim());
      setBackupCodes(r.backupCodes || []);
      setStage('codes');
      setCode('');
    } catch (e: any) {
      toast.error(e?.message || 'That code did not match');
    } finally { setBusy(false); }
  };

  const box: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 14, padding: 22,
  };
  const input: React.CSSProperties = {
    width: 170, height: 48, borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--surface-2)', color: 'var(--text)', textAlign: 'center',
    fontSize: 19, letterSpacing: '0.3em', fontFamily: 'monospace', outline: 'none',
  };
  const primary: React.CSSProperties = {
    height: 42, padding: '0 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 700, fontSize: 13,
  };

  if (stage === 'loading') return <div style={{ ...box, height: 120, opacity: 0.5 }} />;

  return (
    <div style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>Two-factor authentication</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            Required for every merchant account.
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
          background: stage === 'active' ? 'var(--success-bg, #dcfce7)' : 'var(--warning-bg, #fef3c7)',
          color: stage === 'active' ? 'var(--success, #15803d)' : 'var(--warning, #b45309)',
        }}>
          {stage === 'active' ? 'Active' : 'Not set up'}
        </span>
      </div>

      {stage === 'idle' && (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.6 }}>
            Your account moves real money. Until you enrol, a password is the only thing
            standing between an attacker and your settlement balance.
          </p>
          <button onClick={begin} disabled={busy} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Starting…' : 'Set up now'}
          </button>
        </>
      )}

      {stage === 'scanning' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13 }}>1. Scan with Google Authenticator</div>
          {qr && <img src={qr} width={208} height={208} alt="Two-factor setup QR code"
                      style={{ alignSelf: 'center', borderRadius: 10, background: '#fff', padding: 8 }} />}
          <div style={{ fontSize: 13 }}>2. Can’t scan? Enter this key by hand:</div>
          <code style={{
            display: 'block', wordBreak: 'break-all', fontSize: 12, fontFamily: 'monospace',
            background: 'var(--surface-2)', padding: '9px 11px', borderRadius: 8,
          }}>{secret}</code>
          <div style={{ fontSize: 13 }}>3. Enter the 6-digit code it shows:</div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) activate(); }}
            inputMode="numeric" autoComplete="one-time-code" placeholder="000000" style={input}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={activate} disabled={busy || code.length !== 6}
                    style={{ ...primary, opacity: busy || code.length !== 6 ? 0.6 : 1 }}>
              {busy ? 'Verifying…' : 'Activate'}
            </button>
            <button onClick={() => { setStage('idle'); setCode(''); }}
                    style={{ ...primary, background: 'transparent', color: 'var(--muted)' }}>
              Cancel
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Nothing changes until you enter a valid code.
          </div>
        </div>
      )}

      {stage === 'codes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div style={{
            fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 9,
            background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning, #92400e)',
          }}>
            <strong>Save these now — they are shown once.</strong> Each works a single time and is
            the only way back in if you lose your phone.
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, fontFamily: 'monospace',
            fontSize: 13, background: 'var(--surface-2)', padding: 14, borderRadius: 9,
          }}>
            {backupCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved these recovery codes.
          </label>
          <button onClick={() => setStage('active')} disabled={!saved}
                  style={{ ...primary, alignSelf: 'flex-start', opacity: saved ? 1 : 0.5 }}>
            Done
          </button>
        </div>
      )}

      {stage === 'active' && (
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Active. You will be asked for a code at every sign-in. It cannot be switched off —
          merchant accounts settle real money.
        </p>
      )}
    </div>
  );
}

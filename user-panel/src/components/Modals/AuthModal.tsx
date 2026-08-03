// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AuthModal.tsx — 2026 "Bazaar" redesign. Login / register with math captcha.
 * All auth logic (login, register, captcha validation) is unchanged; only the
 * presentation is rebuilt on the redesign theme tokens.
 */
import React, { useEffect, useState } from 'react';
import { useGame } from '../../services/GameContext';

interface AuthModalProps {
  onClose?: () => void;
  initialMode?: 'login' | 'register';
}

function resolveLogo(): string {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    const cdn = (b.cdnBaseUrl || '').replace(/\/+$/, '');
    if (b.logo) return b.logo.startsWith('http') ? b.logo : cdn + '/' + String(b.logo).replace(/^\/+/, '');
  } catch { /* ignore */ }
  return '/app-assets/logo-header.png';
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 };
const inputStyle: React.CSSProperties = { width: '100%', height: 46, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '0 14px', color: 'var(--text)', fontSize: 14, outline: 'none' };

const AuthModal: React.FC<AuthModalProps> = ({ onClose, initialMode }) => {
  const { login, register, pendingChallenge, submitTwoFactor, cancelTwoFactor } = useGame();
  const [isLogin, setIsLogin] = useState(initialMode !== 'register');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [captcha, setCaptcha] = useState({ q: '', a: 0 });
  const [captchaInput, setCaptchaInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [otp, setOtp] = useState('');
  // Optional at signup; opted-in players are challenged at every login after.
  const [enable2FA, setEnable2FA] = useState(false);

  const generateCaptcha = () => {
    const n1 = Math.floor(Math.random() * 9) + 1;
    const n2 = Math.floor(Math.random() * 9) + 1;
    setCaptcha({ q: `${n1} + ${n2}`, a: n1 + n2 });
    setCaptchaInput('');
  };
  useEffect(() => { generateCaptcha(); }, [isLogin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (parseInt(captchaInput) !== captcha.a) { setError('Incorrect security answer'); generateCaptcha(); return; }
    setLoading(true);
    try {
      let success = false;
      if (isLogin) {
        const r = await login(mobile, password);
        // Password accepted, OTP owed: swap to the code step. Not a failure,
        // and deliberately not a closed modal — there is no session yet.
        if (typeof r === 'object' && r.twoFactorRequired) { setLoading(false); return; }
        success = r === true;
      } else {
        if (!username.trim()) throw new Error('Username required');
        success = await register(username, mobile, password, enable2FA);
      }
      if (!success) { setError('Authentication failed. Check credentials.'); generateCaptcha(); }
      else { onClose?.(); }
    } catch (e: any) { setError(e.message || 'Something went wrong. Please try again.'); generateCaptcha(); }
    finally { setLoading(false); }
  };

  const handleOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await submitTwoFactor(otp.trim());
      setOtp('');
      onClose?.();
    } catch (err: any) {
      setError(err?.message || 'Invalid authentication code');
      setOtp('');
    } finally { setLoading(false); }
  };

  // ── OTP step ────────────────────────────────────────────────────────────
  // A separate form, not an extra field: the password was already accepted,
  // and re-submitting it would restart the login from scratch.
  if (pendingChallenge) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
        <form onSubmit={handleOtp} className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
          <p style={{ margin: '0 0 6px', textAlign: 'center', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--gold-ink)' }}>Two-factor code</p>
          <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
            Enter the 6-digit code from your authenticator app.
          </p>
          <input
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, 9))}
            inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000000"
            className="font-grotesk"
            style={{ ...inputStyle, height: 54, textAlign: 'center', fontSize: 21, letterSpacing: '.3em' }}
          />
          {error && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger, #ef4444)', textAlign: 'center' }}>{error}</div>}
          <button type="submit" disabled={loading || otp.trim().length < 6}
                  style={{ width: '100%', height: 48, marginTop: 14, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'var(--gold)', color: 'var(--gold-on)', fontWeight: 800, fontSize: 14, opacity: loading || otp.trim().length < 6 ? .6 : 1 }}>
            {loading ? 'Verifying…' : 'Verify and sign in'}
          </button>
          <button type="button" onClick={() => { cancelTwoFactor(); setOtp(''); setError(''); }}
                  style={{ width: '100%', height: 40, marginTop: 8, background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer' }}>
            Back to sign in
          </button>
          <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.5 }}>
            Lost your phone? Enter a recovery code instead — each works once.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(900px 480px at 50% -6%, var(--glow), transparent 62%)', opacity: .5, pointerEvents: 'none' }} />
      {onClose && <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 15, zIndex: 2 }}>✕</button>}
      <form onSubmit={handleSubmit} className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          {!logoFailed ? <img src={resolveLogo()} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{ height: 34, width: 'auto', maxWidth: 220, objectFit: 'contain', filter: 'drop-shadow(0 2px 10px var(--glow))' }} />
            : <span className="font-grotesk" style={{ color: 'var(--gold-ink)', fontWeight: 700, fontSize: 20, letterSpacing: '.14em' }}>BETTING BAZAAR</span>}
        </div>
        <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--gold-ink)' }}>{isLogin ? 'Login to Play' : 'Create Account'}</p>

        {!isLogin && <div style={{ marginBottom: 11 }}><label style={labelStyle}>Username</label><input value={username} onChange={e => setUsername(e.target.value)} placeholder="PlayerOne" autoComplete="username" style={inputStyle} /></div>}
        <div style={{ marginBottom: 11 }}><label style={labelStyle}>Mobile number</label><input value={mobile} onChange={e => setMobile(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))} inputMode="numeric" placeholder="9876543210" autoComplete="tel" className="font-grotesk" style={inputStyle} /></div>
        <div style={{ marginBottom: 11 }}><label style={labelStyle}>Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete={isLogin ? 'current-password' : 'new-password'} style={inputStyle} /></div>

        {/* Optional for players — mandatory only for staff and merchants.
            Ticking this mints a PENDING secret; the account stays usable and
            only starts demanding codes once the QR is actually scanned and a
            code verified, so a half-finished setup cannot lock anyone out. */}
        {!isLogin && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, cursor: 'pointer', background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '11px 13px' }}>
            <input type="checkbox" checked={enable2FA} onChange={e => setEnable2FA(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Protect my account with an authenticator app</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginTop: 2, lineHeight: 1.45 }}>
                We’ll show you a QR code to scan after signup. You’ll then enter a 6-digit code each time you log in.
              </span>
            </span>
          </label>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
          <div><div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 2 }}>Security check</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, letterSpacing: '.1em', color: 'var(--gold-ink)' }}>{captcha.q} = ?</div></div>
          <input value={captchaInput} onChange={e => setCaptchaInput(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="Ans" required className="font-grotesk" style={{ width: 72, height: 42, textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 10, color: 'var(--text)', fontSize: 15, fontWeight: 800, outline: 'none' }} />
        </div>
        {error && <div style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 8, textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 12 }}>{error}</div>}

        <button type="submit" disabled={loading} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 14, letterSpacing: '.08em', color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)', opacity: loading ? .6 : 1 }}>{loading ? 'Processing…' : (isLogin ? 'ENTER ARENA' : 'REGISTER NOW')}</button>

        <div style={{ textAlign: 'center', marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span onClick={() => { setIsLogin(!isLogin); setError(''); setUsername(''); }} style={{ fontSize: 12, color: 'var(--text2)', cursor: 'pointer', textDecoration: 'underline' }}>{isLogin ? 'New Player? Create Account' : 'Already have an account? Login'}</span>
          <a href="#/recover-account" onClick={() => onClose?.()} style={{ fontSize: 11, color: 'var(--text3)', cursor: 'pointer', textDecoration: 'underline' }}>Lost access to your account? Recover it here</a>
        </div>
      </form>
    </div>
  );
};

export default AuthModal;

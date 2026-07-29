// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Command Center sign-in — recreated from the design handoff. Auth flow
// (mobile + password, role-based post-login redirect) is unchanged.
import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { useAuthStore } from '../services/auth';
import { LogoMark, getBrand } from '../components/Logo';
import toast from 'react-hot-toast';

type LoginType = 'admin' | 'subadmin' | 'queue_manager';

const ROLES: { id: LoginType; label: string }[] = [
  { id: 'admin', label: 'Super Admin' },
  { id: 'subadmin', label: 'Sub-Admin' },
  { id: 'queue_manager', label: 'Queue Manager' },
];

export const Login: React.FC = () => {
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [loginType, setLoginType] = useState<LoginType>('admin');
  const [isLoading, setIsLoading] = useState(false);
  const [otp, setOtp] = useState('');
  const navigate = useNavigate();
  const { login, submitTwoFactor, cancelTwoFactor, pendingChallenge } = useAuthStore();
  const brand = getBrand();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await login(mobile, password, loginType);
      // Password accepted but a second factor is owed — the form swaps to the
      // OTP step and this submit is done. Not an error, not a session yet.
      if (useAuthStore.getState().pendingChallenge) { setIsLoading(false); return; }
      routeAfterLogin();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Login failed. Check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Landing route by role. Shared by the password-only path and the post-OTP
   * path so a 2FA login cannot land somewhere different from a normal one.
   */
  const routeAfterLogin = () => {
    const { admin } = useAuthStore.getState();
    if (!admin) throw new Error('Login failed');

    if (admin.isAdmin) {
      navigate('/');
    } else if (admin.isQueueManager) {
      navigate('/queue-manager');
    } else {
      const perms = (admin.permissions || {}) as import('../types').SubAdminPermissions;
      if (perms.canViewAnalytics) navigate('/');
      else if (perms.canManageUsers) navigate('/users');
      else if (perms.canManageMerchants) navigate('/merchants');
      else if (perms.canVerifyKYC) navigate('/kyc');
      else if (perms.canViewTransactions) navigate('/transactions');
      else if (perms.canManageContent) navigate('/content/faq');
      else navigate('/login');
    }
    toast.success('Login successful!');
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await submitTwoFactor(otp.trim());
      setOtp('');
      routeAfterLogin();
    } catch (error: any) {
      toast.error(error?.message || 'Invalid authentication code');
      setOtp('');
    } finally {
      setIsLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 42, borderRadius: 10, border: '1px solid var(--input-border)',
    background: 'var(--input)', color: 'var(--text)', padding: '0 13px', fontSize: 13, outline: 'none',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} className="om-fade">
      <div style={{ width: 410, maxWidth: '94vw' }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 22 }}>
          <LogoMark size={52} radius={14} />
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em', marginTop: 13 }}>{brand.appName}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', marginTop: 3 }}>{brand.adminPanelName}</div>
        </div>

        {/* Card */}
        {/* ── OTP step ────────────────────────────────────────────────────
            Swaps the whole card rather than appending a field: the password
            has already been accepted and re-submitting it would restart the
            login. Showing it still filled in would invite exactly that. */}
        {pendingChallenge ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Two-factor authentication</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>
            Enter the 6-digit code from your authenticator app.
          </div>
          <form onSubmit={handleOtpSubmit}>
            <input
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, 9))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="000000"
              style={{ ...inputStyle, textAlign: 'center', fontSize: 20, letterSpacing: '0.3em', fontFamily: 'monospace', height: 52 }}
            />
            <button
              type="submit"
              disabled={isLoading || otp.trim().length < 6}
              className="btn btn-primary"
              style={{ width: '100%', height: 42, marginTop: 14, opacity: isLoading || otp.trim().length < 6 ? 0.6 : 1 }}
            >
              {isLoading ? 'Verifying…' : 'Verify and sign in'}
            </button>
            <button
              type="button"
              onClick={() => { cancelTwoFactor(); setOtp(''); }}
              style={{ width: '100%', height: 38, marginTop: 8, background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}
            >
              Back to sign in
            </button>
          </form>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
            Lost your phone? Enter one of your recovery codes instead — each works once.
          </div>
        </div>
        ) : (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Sign in</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>Choose your role to continue</div>

          <form onSubmit={handleSubmit}>
            {/* Role picker */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {ROLES.map((r) => {
                const active = loginType === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setLoginType(r.id)}
                    style={{
                      flex: 1, textAlign: 'center', padding: '11px 6px', borderRadius: 9, fontSize: 12,
                      fontWeight: 700, cursor: 'pointer', transition: 'all .15s',
                      border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                      color: active ? 'var(--gold-ink)' : 'var(--text-2)',
                      background: active ? 'var(--warning-bg)' : 'transparent',
                    }}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>

            {/* Mobile */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7 }}>Mobile number</label>
            <div style={{ display: 'flex', alignItems: 'center', height: 42, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', marginBottom: 14, overflow: 'hidden' }}>
              <span style={{ padding: '0 12px', fontSize: 13, fontWeight: 700, color: 'var(--muted)', borderRight: '1px solid var(--border)', height: '100%', display: 'flex', alignItems: 'center', fontFamily: "'JetBrains Mono',monospace" }}>+91</span>
              <input
                type="tel"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="98000 12345"
                required
                style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', color: 'var(--text)', padding: '0 12px', fontSize: 13, outline: 'none', fontFamily: "'JetBrains Mono',monospace" }}
              />
            </div>

            {/* Password */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{ ...inputStyle, marginBottom: 20 }}
            />

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: '100%', height: 44, borderRadius: 10, background: 'var(--gold)', color: 'var(--gold-on)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 800,
                cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.6 : 1, border: 'none',
              }}
            >
              {isLoading ? 'Signing in…' : 'Sign in'} {!isLoading && <ArrowRight size={16} />}
            </button>
          </form>
        </div>
        )}

        {/* Says only what is true. This line previously disclaimed 2FA
            entirely — correct at the time, since no TOTP challenge existed.
            It does now (identity/twoFactorChallenge.js), but it is only real
            for accounts that have ENROLLED, so the wording still promises
            nothing about this particular session. */}
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 16 }}>
          Sessions and privileged actions are logged to Audit Logs
        </div>
      </div>
    </div>
  );
};

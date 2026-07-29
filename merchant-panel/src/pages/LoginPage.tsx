// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Operator sign-in and merchant application — design handoff
// "BB Merchant Panel.dc.html". A merchant's settlement rail is assigned by an
// admin after approval, so it is deliberately not asked for here.
import React, { useState } from 'react';
import { Navigate } from 'react-router';
import { Lock, Smartphone, Mail, User as UserIcon, ShieldCheck, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { APP_CONFIG, ROUTES } from '../constants';
import { Button, Field, Logo, Spinner, inputStyle } from '../components/ui';

type Tab = 'login' | 'signup';

const MIN_PASSWORD_LENGTH = 8; // backend: merchant.routes.js POST /auth/signup

const LoginPage: React.FC = () => {
  const { merchant, loading: authLoading, login, pendingChallenge, submitTwoFactor, cancelTwoFactor } = useAuth();
  const [tab, setTab] = useState<Tab>('login');

  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [otp, setOtp] = useState('');

  const [form, setForm] = useState({ username: '', mobile: '', email: '', password: '', confirmPassword: '' });
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  if (!authLoading && merchant) return <Navigate to={ROUTES.DASHBOARD} replace />;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    try {
      await login({ mobile, password });
    } catch {
      // AuthContext surfaces the message; keep the operator on the form.
    } finally {
      setSigningIn(false);
    }
  };

  const handleOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    try {
      await submitTwoFactor(otp.trim());
      setOtp('');
    } catch {
      // AuthContext toasts the reason. Clear the field so a stale wrong code
      // is not resubmitted by a second Enter press.
      setOtp('');
    } finally {
      setSigningIn(false);
    }
  };

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) { toast.error('Passwords do not match'); return; }
    if (form.password.length < MIN_PASSWORD_LENGTH) { toast.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`); return; }
    setApplying(true);
    try {
      const res = await api.merchantSignup({
        username: form.username,
        mobile: form.mobile,
        email: form.email || undefined,
        password: form.password,
        confirmPassword: form.confirmPassword,
      });
      if (res.success) setApplied(true);
    } catch (error: any) {
      toast.error(error.message || 'Application failed');
    } finally {
      setApplying(false);
    }
  };

  const tabStyle = (value: Tab): React.CSSProperties => ({
    flex: 1, padding: 10, border: 0, borderRadius: 11, cursor: 'pointer', fontSize: 13, fontWeight: 700,
    background: tab === value ? 'var(--surface)' : 'transparent',
    color: tab === value ? 'var(--brand)' : 'var(--muted)',
    boxShadow: tab === value ? 'var(--shadow)' : 'none',
    transition: 'background .15s ease, color .15s ease',
  });

  const iconStyle: React.CSSProperties = { position: 'absolute', left: 13, top: 12, color: 'var(--muted)' };
  const withIcon: React.CSSProperties = { ...inputStyle, padding: '12px 14px 12px 40px', fontSize: 14, borderRadius: 12 };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      padding: '32px 22px', background: 'linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 26 }}>
          <Logo size={56} radius={16} />
          <h1 style={{ margin: '18px 0 4px', fontSize: 23, fontWeight: 800, letterSpacing: '-.5px', color: 'var(--text)' }}>
            BB Token
          </h1>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-2)' }}>Merchant Panel</p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '6px 12px',
            background: 'var(--dep-bg)', borderRadius: 20,
          }}>
            <ShieldCheck size={13} style={{ color: 'var(--dep)' }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--dep)' }}>Secure operator sign-in</span>
          </div>
        </div>

        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
          boxShadow: 'var(--shadow)', overflow: 'hidden',
        }}>
          {/* The tab strip is hidden mid-2FA: the password has already been
              accepted, and letting the operator wander to "Apply as Merchant"
              would silently abandon a challenge that expires in 5 minutes. */}
          {!pendingChallenge && (
          <div style={{ display: 'flex', padding: 6, gap: 4, background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
            <button onClick={() => setTab('login')} style={tabStyle('login')}>Login</button>
            <button onClick={() => setTab('signup')} style={tabStyle('signup')}>Apply as Merchant</button>
          </div>
          )}

          <div style={{ padding: '22px 22px 24px' }}>
            {pendingChallenge ? (
              <form onSubmit={handleOtp} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Two-factor authentication</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Enter the 6-digit code from your authenticator app.
                  </div>
                </div>
                <input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, 9))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                  style={{
                    width: '100%', height: 52, borderRadius: 10, border: '1px solid var(--border)',
                    background: 'var(--surface-2)', color: 'var(--text)', textAlign: 'center',
                    fontSize: 20, letterSpacing: '0.3em', fontFamily: 'monospace', outline: 'none',
                  }}
                />
                <button type="submit" disabled={signingIn || otp.trim().length < 6} style={{
                  width: '100%', height: 44, borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 700, fontSize: 14,
                  opacity: signingIn || otp.trim().length < 6 ? 0.6 : 1,
                }}>
                  {signingIn ? 'Verifying…' : 'Verify and sign in'}
                </button>
                <button type="button" onClick={() => { cancelTwoFactor(); setOtp(''); }} style={{
                  background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
                }}>
                  Back to sign in
                </button>
                <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                  Lost your phone? Enter one of your recovery codes instead — each works once.
                </div>
              </form>
            ) : tab === 'login' ? (
              <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Field label="Mobile number">
                  <div style={{ position: 'relative' }}>
                    <Smartphone size={17} style={iconStyle} />
                    <input
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      placeholder="10-digit mobile"
                      inputMode="numeric"
                      autoComplete="username"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Password">
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      autoComplete="current-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Button type="submit" full busy={signingIn} disabled={!mobile || !password} style={{ padding: 13, fontSize: 14, borderRadius: 12 }}>
                  {signingIn ? 'Signing in…' : 'Sign in securely'}
                </Button>
                <p style={{ margin: 0, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                  Trouble signing in? Contact your operations admin.
                </p>
              </form>
            ) : applied ? (
              <div style={{ textAlign: 'center', padding: '14px 0' }}>
                <CheckCircle size={44} style={{ color: 'var(--ok)' }} />
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: '12px 0 6px' }}>
                  Application submitted
                </div>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 18px' }}>
                  An admin reviews your application and assigns your settlement rail — INR or USDT.
                  You can sign in once it is approved.
                </p>
                <Button variant="outline" tone="neutral" full onClick={() => { setApplied(false); setTab('login'); }} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  Back to login
                </Button>
              </div>
            ) : (
              <form onSubmit={handleApply} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <div style={{
                  display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px',
                  background: 'var(--warn-bg)', border: '1px solid var(--warn)', borderRadius: 12,
                }}>
                  <ShieldCheck size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)', lineHeight: 1.5 }}>
                    Applications are reviewed by an admin before you can sign in.
                  </span>
                </div>
                <Field label="Username">
                  <div style={{ position: 'relative' }}>
                    <UserIcon size={17} style={iconStyle} />
                    <input
                      value={form.username}
                      onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                      placeholder="Choose a username"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Mobile number">
                  <div style={{ position: 'relative' }}>
                    <Smartphone size={17} style={iconStyle} />
                    <input
                      value={form.mobile}
                      onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
                      placeholder="10-digit mobile"
                      inputMode="numeric"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Email (optional)">
                  <div style={{ position: 'relative' }}>
                    <Mail size={17} style={iconStyle} />
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                      placeholder="you@example.com"
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Password" hint={`Minimum ${MIN_PASSWORD_LENGTH} characters.`}>
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                      autoComplete="new-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Confirm password">
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      type="password"
                      value={form.confirmPassword}
                      onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                      placeholder="Re-enter password"
                      autoComplete="new-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Button type="submit" tone="brand" full busy={applying} style={{ padding: 13, fontSize: 14, borderRadius: 12 }}>
                  Submit application
                </Button>
              </form>
            )}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 18, lineHeight: 1.6 }}>
          Authorised payment operators only. All activity is logged and monitored for compliance.
          {/* VITE_APP_VERSION is injected from package.json at build time (L-03);
              a dev build without it falls back to '—', which is worth omitting
              rather than printing as "v—". */}
          {APP_CONFIG.VERSION !== '—' && (
            <>
              <br />
              <span className="bb-mono">v{APP_CONFIG.VERSION}</span>
            </>
          )}
        </p>
      </div>

      {authLoading && (
        <div style={{ marginTop: 20 }}>
          <Spinner />
        </div>
      )}
    </div>
  );
};

export default LoginPage;

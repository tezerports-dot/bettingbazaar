// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MyAuthenticator.tsx — the signed-in staff account's own authenticator.
 *
 * Every staff account, of any role, sees whether its app is set up and how
 * many recovery codes it has left, and makes ten new ones (the old ones stop
 * working) with a current app code. The server mounts both routes with
 * `authenticateStaff` and no area (SELF_ROUTES, staffPermissions.js), so this
 * is its own screen.
 *
 * Server: `GET /api/admin/account/2fa`, `POST …/2fa/recovery-codes`
 * (backend/routes/admin/account.admin.routes.js). A wrong code is a 400, not a
 * 401, so it never ends this session.
 *
 * Moving to a new phone is a reset by another admin (Staff screen), then
 * setting the app up again at the next sign-in.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type AuthenticatorState } from '../../services/api';
import { formatters } from '../../utils/formatters';
import { refusalText } from '../../utils/refusal';
import { RecoveryCodes } from '../../components/RecoveryCodes';
import { getBrand } from '../../components/Logo';

const alertStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
  background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)', marginBottom: 12,
};

/** One labelled line. Module level (§32 S23). */
const Row: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
    <div style={{ width: 170, flex: 'none', color: 'var(--muted)', fontWeight: 600 }}>{name}</div>
    <div style={{ fontWeight: 700 }}>{children}</div>
  </div>
);

export const MyAuthenticator: React.FC = () => {
  const [view, setView] = useState<AuthenticatorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.account.authenticator());
      setLoadError(null);
    } catch (err) {
      setLoadError(refusalText(err, 'Could not read your authenticator.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const regenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const codes = await api.account.regenerateRecoveryCodes(code.trim());
      setFresh(codes);
      setCode('');
      toast.success('New recovery codes made. The old ones no longer work.');
      void load();
    } catch (err) {
      setError(refusalText(err, 'Could not make new recovery codes.'));
    } finally {
      setBusy(false);
    }
  };

  const off = busy || !/^\d{6}$/.test(code.trim());

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {loadError && <div role="alert" style={alertStyle}>{loadError}</div>}

      {!view && !loadError && (
        <div role="status" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      )}

      {view && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <KeyRound size={18} style={{ color: 'var(--gold-ink)' }} />
            <div style={{ fontSize: 15, fontWeight: 800 }}>My Authenticator</div>
          </div>
          <Row name="Authenticator app">{view.enrolled ? 'Set up' : 'Not set up'}</Row>
          <Row name="Set up on">{view.enrolledAt ? formatters.datetime(view.enrolledAt) : '—'}</Row>
          <Row name="Recovery codes left">{view.enrolled ? String(view.recoveryCodesLeft) : '—'}</Row>
          <Row name="Codes made on">{view.recoveryGeneratedAt ? formatters.datetime(view.recoveryGeneratedAt) : '—'}</Row>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }}>
            New phone? Ask another admin to reset your authenticator on the Staff screen; you set
            the app up again at your next sign-in.
          </div>
        </div>
      )}

      {view?.enrolled && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>New recovery codes</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
            Makes ten new codes and stops the old ones working. Enter the code your app shows now.
          </div>
          {error && <div role="alert" style={alertStyle}>{error}</div>}
          {fresh ? (
            <>
              <div role="status" style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>
                Shown only now. Keep them somewhere safe, away from your phone.
              </div>
              <RecoveryCodes codes={fresh} appName={getBrand().appName} />
              <button type="button" className="btn" onClick={() => setFresh(null)}>I saved them</button>
            </>
          ) : (
            <form onSubmit={regenerate} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label htmlFor="regen-code" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7 }}>
                  Authenticator code
                </label>
                <input
                  id="regen-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  style={{ width: 160, height: 40, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 12px', fontSize: 16, letterSpacing: '.2em', fontFamily: "'JetBrains Mono',monospace" }}
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={off} style={{ height: 40, opacity: off ? 0.6 : 1 }}>
                {busy ? 'Making…' : 'Make new codes'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

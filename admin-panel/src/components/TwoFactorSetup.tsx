// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * TwoFactorSetup — enrol this admin account in TOTP 2FA.
 *
 * Mirrors the server's two-step handshake (/api/2fa/setup then /activate)
 * because the middle state is real: a secret exists but is PENDING, and the
 * account is not yet protected. Collapsing the two would mean an admin who
 * closes this panel after seeing the QR but before typing a code owns an
 * account demanding codes from an authenticator entry that may not exist —
 * and for the main admin there is nobody above them to undo that.
 *
 * The recovery codes step is deliberately blocking. They are shown exactly
 * once; if the operator clicks past them they are gone, and a lost handset
 * then means a permanently locked platform-owner account. So the panel makes
 * them confirm they have saved the codes rather than offering a quiet dismiss.
 */
import { useEffect, useState } from 'react';
import api from '../services/api';
import OtpAuthQr from './OtpAuthQr';

type Stage = 'loading' | 'idle' | 'scanning' | 'codes' | 'active';

export default function TwoFactorSetup() {
  const [stage, setStage] = useState<Stage>('loading');
  const [mandatory, setMandatory] = useState(false);
  const [otpauthUri, setOtpauthUri] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.twoFactor.status()
      .then((r) => {
        setMandatory(!!r?.mandatory);
        setStage(r?.enabled ? 'active' : 'idle');
      })
      .catch(() => setStage('idle'));
  }, []);

  const begin = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.twoFactor.setup();
      if (!r?.success) throw new Error(r?.message || 'Could not start setup');
      setOtpauthUri(r.otpauthUri);
      setSecret(r.secret);
      setStage('scanning');
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Could not start setup');
    } finally { setBusy(false); }
  };

  const activate = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.twoFactor.activate(code.trim());
      if (!r?.success) throw new Error(r?.message || 'That code did not match');
      setBackupCodes(r.backupCodes || []);
      setStage('codes');
      setCode('');
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'That code did not match');
    } finally { setBusy(false); }
  };

  const downloadCodes = () => {
    const blob = new Blob(
      [`Betting Bazaar — admin recovery codes\nGenerated ${new Date().toISOString()}\n\n`
        + backupCodes.join('\n')
        + '\n\nEach code works once. Store them somewhere you can reach WITHOUT this account.\n'],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'betting-bazaar-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (stage === 'loading') {
    return <div className="animate-pulse h-32 rounded-xl bg-slate-200 dark:bg-slate-700" />;
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Two-factor authentication</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            A code from your authenticator app, required at every sign-in.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
          stage === 'active'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
        }`}>
          {stage === 'active' ? 'Active' : 'Not set up'}
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {stage === 'idle' && (
        <>
          {mandatory && (
            <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              Your role requires two-factor authentication. Until you enrol, this account is
              protected by a password alone.
            </p>
          )}
          <button
            onClick={begin}
            disabled={busy}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        </>
      )}

      {stage === 'scanning' && (
        <div className="space-y-5">
          <ol className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
            <li>
              <strong>1.</strong> Scan this with Google Authenticator (or any TOTP app).
              <div className="mt-3 flex justify-center">
                <OtpAuthQr uri={otpauthUri} />
              </div>
            </li>
            <li>
              <strong>2.</strong> Can’t scan? Enter this key by hand:
              <code className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-slate-900">
                {secret}
              </code>
            </li>
            <li>
              <strong>3.</strong> Type the 6-digit code it shows:
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) activate(); }}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                className="mt-2 w-40 rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] dark:border-slate-600 dark:bg-slate-900 dark:text-white"
              />
            </li>
          </ol>
          <div className="flex gap-3">
            <button
              onClick={activate}
              disabled={busy || code.length !== 6}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Activate'}
            </button>
            <button
              onClick={() => { setStage('idle'); setCode(''); setError(''); }}
              className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Nothing changes until you enter a valid code — your account is not yet asking for one.
          </p>
        </div>
      )}

      {stage === 'codes' && (
        <div className="space-y-4">
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            <strong>Save these now — they are shown once.</strong> Each works a single time and is
            the only way back into this account if you lose your phone. Store them somewhere you
            can reach <em>without</em> this account.
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-4 font-mono text-sm dark:bg-slate-900">
            {backupCodes.map((c) => <div key={c} className="text-slate-800 dark:text-slate-200">{c}</div>)}
          </div>
          <button
            onClick={downloadCodes}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Download as .txt
          </button>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={savedConfirmed}
              onChange={(e) => setSavedConfirmed(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            I have saved these recovery codes.
          </label>
          <button
            onClick={() => setStage('active')}
            disabled={!savedConfirmed}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Done
          </button>
        </div>
      )}

      {stage === 'active' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Two-factor authentication is active. You will be asked for a code at every sign-in.
          </p>
          {mandatory && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Your role requires it, so it cannot be switched off from here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * NativeUpdateGate — the Android app offers, or insists on, its own update.
 *
 * Renders nothing on the web and nothing when the install is current. In the
 * APK it asks the server on launch, every time the app returns to the
 * foreground, and every half hour:
 *
 *   required     a full-screen block with no way past it — a release an admin
 *                marked mandatory is above this install
 *   unsupported  a full-screen block that says the PHONE is too old: a
 *                mandatory release needs a newer Android than it has, so there
 *                is no update to offer and pretending otherwise is a loop
 *   available    a sheet the player can put off for a day ("Later")
 *
 * "Update" downloads inside the app with a progress bar, verifies the file's
 * SHA-256 against the one the server published, and opens Android's installer.
 * The first time, Android asks the player to allow this app to install updates
 * at all; the sheet explains that, opens the exact switch, and tries the
 * install again by itself when they come back.
 *
 * The rule for WHICH status applies lives on the server
 * (androidRelease.routes.js updateStatus); this component only renders it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeShell } from '../services/nativeLifecycle';
import { brandLogo, fallBackToMark } from '../services/brandAssets';
import type { UpdateCheck } from '../services/nativeUpdater';

type Phase = 'idle' | 'downloading' | 'installing' | 'permission' | 'launched' | 'error';
type Updater = typeof import('../services/nativeUpdater');

// §11: a UI cadence, not a business rule — how often an open app re-asks. The
// server decides WHAT to do; nothing here is used for server-side validation.
const RECHECK_MS = 30 * 60 * 1000;

const BUTTON: React.CSSProperties = {
  width: '100%', height: 50, borderRadius: 14, border: 'none', fontWeight: 800,
  fontSize: 15, letterSpacing: '0.02em', cursor: 'pointer',
  background: 'var(--brand-primary)', color: 'black',   // the panel's black-on-brand (text-black)
};
const SECONDARY: React.CSSProperties = {
  ...BUTTON, background: 'transparent', color: 'var(--text2)', border: '1px solid var(--line2)', fontWeight: 700,
};

export default function NativeUpdateGate() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const mod = useRef<Updater | null>(null);
  const path = useRef<string | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const updater = async (): Promise<Updater> => (mod.current ??= await import('../services/nativeUpdater'));

  const install = useCallback(async () => {
    if (!path.current) return;
    const u = await updater();
    setPhase('installing');
    try {
      const { status } = await u.ApkUpdater.install({ path: path.current });
      setPhase(status === 'needs_permission' ? 'permission' : 'launched');
    } catch (e) {
      setError((e as Error)?.message || 'The installer could not be opened.');
      setPhase('error');
    }
  }, []);

  const start = useCallback(async () => {
    const latest = check?.latest;
    if (!latest) return;
    const u = await updater();
    setError('');
    setProgress(0);
    setPhase('downloading');
    const listener = await u.ApkUpdater.addListener('downloadProgress', ({ received, total }) => {
      setProgress(u.percent(received, total || latest.sizeBytes));
    });
    try {
      const { path: file } = await u.ApkUpdater.download({
        url: latest.downloadUrl, sha256: latest.sha256, sizeBytes: latest.sizeBytes,
      });
      path.current = file;
      setProgress(100);
      await install();
    } catch (e) {
      setError((e as Error)?.message || 'The update could not be downloaded.');
      setPhase('error');
    } finally {
      listener.remove();
    }
  }, [check, install]);

  useEffect(() => {
    if (!isNativeShell()) return undefined;
    let cancelled = false;
    let removeResume: (() => void) | null = null;

    const run = async () => {
      const u = await updater();
      const next = await u.checkForUpdate();
      if (cancelled || !next) return;       // offline: never block on a check that could not be made
      setCheck(next);
      setVisible(u.shouldShow(next));
    };

    run();
    const timer = setInterval(run, RECHECK_MS);
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const h = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          // Back from Settings after allowing installs: carry on by ourselves.
          if (phaseRef.current === 'permission') install();
          else if (phaseRef.current === 'idle') run();
        });
        removeResume = () => { h.remove(); };
      } catch { /* no lifecycle events — the timer still re-checks */ }
    })();

    return () => { cancelled = true; clearInterval(timer); removeResume?.(); };
  }, [install]);

  if (visible && check?.status === 'unsupported') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--app-bg)', padding: '24px 22px', paddingTop: 'env(safe-area-inset-top)' }}>
        <div role="alertdialog" aria-modal="true" aria-labelledby="unsupported-title"
          style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--text)' }}>
          <img src={brandLogo('logo.png')} onError={fallBackToMark} alt="" style={{ width: 52, height: 52, objectFit: 'contain', borderRadius: 12 }} />
          <h2 id="unsupported-title" style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>This phone's Android is too old</h2>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'var(--text2)' }}>
            This version of the app is no longer supported, and the update it needs requires
            {' '}<strong>{check.requiredAndroid || 'a newer Android'}</strong> or newer.
            To keep playing, use a phone with a newer Android, or play in your phone's web browser.
            Your account and balance are not affected.
          </p>
        </div>
      </div>
    );
  }
  if (!visible || !check?.latest) return null;
  const { latest } = check;
  const required = check.status === 'required';
  const busy = phase === 'downloading' || phase === 'installing';

  const later = () => {
    mod.current?.snooze(latest.versionCode);
    setVisible(false);
  };

  const body = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      style={{
        width: '100%', maxWidth: 420, background: required ? 'transparent' : 'var(--surface)', color: 'var(--text)',
        borderRadius: required ? 0 : '22px 22px 0 0', padding: '28px 22px calc(22px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'stretch',
        border: required ? 'none' : '1px solid var(--line2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img src={brandLogo('logo.png')} onError={fallBackToMark} alt="" style={{ width: 52, height: 52, objectFit: 'contain', borderRadius: 12 }} />
        <div>
          <h2 id="update-title" style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>
            {required ? 'Update required' : 'Update available'}
          </h2>
          <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 2 }}>
            Version {latest.versionName}
            {mod.current?.formatSize(latest.sizeBytes) ? ` · ${mod.current.formatSize(latest.sizeBytes)}` : ''}
          </div>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'var(--text2)' }}>
        {required
          ? 'This version of the app is no longer supported. Update to keep playing — your account and balance are not affected.'
          : 'A newer version is ready. It installs over this one — your account and balance are not affected.'}
      </p>

      {latest.releaseNotes && (
        <div style={{
          fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto',
          background: 'rgba(var(--brand-primary-rgb), 0.06)', border: '1px solid rgba(var(--brand-primary-rgb), 0.18)',
          borderRadius: 12, padding: '10px 12px',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>What's new</div>
          {latest.releaseNotes}
        </div>
      )}

      {phase === 'downloading' && (
        <div aria-live="polite">
          <div style={{ height: 8, borderRadius: 8, background: 'var(--line2)', overflow: 'hidden' }}>
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
              style={{ width: `${progress}%`, height: '100%', background: 'var(--brand-primary)', transition: 'width 0.2s' }}
            />
          </div>
          <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 6 }}>Downloading… {progress}%</div>
        </div>
      )}
      {phase === 'installing' && <div aria-live="polite" style={{ fontSize: 13, color: 'var(--text2)' }}>Opening the installer…</div>}

      {phase === 'permission' && (
        <div aria-live="polite" style={{ fontSize: 14, lineHeight: 1.5 }}>
          <strong>One-time permission.</strong> Android needs you to allow this app to install its updates.
          Tap <em>Allow</em>, switch on <em>Allow from this source</em>, then come back — the update continues by itself.
        </div>
      )}
      {phase === 'launched' && (
        <div aria-live="polite" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Tap <strong>Install</strong> on the Android screen. The app reopens on the new version.
        </div>
      )}
      {phase === 'error' && <div role="alert" style={{ fontSize: 14, color: 'var(--red)' }}>{error}</div>}

      {phase === 'permission' ? (
        <>
          <button type="button" style={BUTTON} onClick={() => mod.current?.ApkUpdater.openInstallSettings()}>Allow</button>
          <button type="button" style={SECONDARY} onClick={install}>I've allowed it</button>
        </>
      ) : phase === 'launched' ? (
        <button type="button" style={SECONDARY} onClick={install}>Open the installer again</button>
      ) : (
        <button type="button" style={{ ...BUTTON, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={start}>
          {phase === 'error' ? 'Try again' : busy ? 'Updating…' : 'Update now'}
        </button>
      )}

      {!required && !busy && (
        <button type="button" style={SECONDARY} onClick={later}>Later</button>
      )}
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, display: 'flex',
        alignItems: required ? 'stretch' : 'flex-end', justifyContent: 'center',
        background: required ? 'var(--app-bg)' : 'rgba(0,0,0,0.6)',
        paddingTop: required ? 'env(safe-area-inset-top)' : 0,
      }}
    >
      {required ? <div style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>{body}</div> : body}
    </div>
  );
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a merchant sees when their session is fine and the platform is not.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * "No profile" and "not signed in" are different facts, and the panel treated
 * them as one. A merchant on a new device whose first profile call was refused
 * — a 429 from the global limiter, which every merchant behind one office NAT
 * shares, or a 502 while the gateway restarts — holds a perfectly VALID session
 * and was shown the sign-in form. The obvious thing to do there is type your
 * password, at a platform that already knows who you are and is merely busy.
 * That is S14: a screen blaming the person for the platform's state.
 *
 * One component, used by both places that can land on it (§5), because the
 * wording a merchant reads must not exist in two copies that drift.
 */
import React from 'react';
import { Button } from './ui';

export const PlatformUnreachable: React.FC<{ onRetry: () => Promise<void> | void }> = ({ onRetry }) => {
  const [retrying, setRetrying] = React.useState(false);
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg)', padding: 24,
    }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Cannot reach the platform</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
          You are still signed in — this is the platform, not your account. It is
          busy or restarting. Your orders and your token balance are untouched.
        </p>
        <Button
          disabled={retrying}
          onClick={async () => { setRetrying(true); try { await onRetry(); } finally { setRetrying(false); } }}
        >
          {retrying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </div>
  );
};

export default PlatformUnreachable;

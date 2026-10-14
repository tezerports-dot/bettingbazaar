// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The screens that belong to an account (Wallet, Refer & Earn, Profile, My
 * Bets, Game History), opened while signed out.
 *
 * They used to load anyway; their first read answered 401 and the API client
 * reloaded the app at the board, so tapping Wallet signed out looked like the
 * app ignoring the tap (§32 S48). Signed out, the screen now says what it is
 * and offers the sign-in, and makes no request at all.
 */
import React from 'react';
import { useShell } from './RedesignShell';
import { card } from './Screen';
import { player } from '../services/api';

const SignInFirst: React.FC<{ what: string; children: React.ReactNode }> = ({ what, children }) => {
  const { isAuthenticated, openAuth } = useShell();
  // A stored session is still being restored on a reload: let the screen load
  // as it always has rather than flash the sign-in card at a signed-in player.
  if (isAuthenticated || player.hasStoredSession()) return <>{children}</>;
  return (
    <div style={{ maxWidth: 420, margin: '32px auto', padding: '0 16px' }}>
      <div role="status" style={{ ...card, textAlign: 'center', padding: 24 }}>
        <div aria-hidden="true" style={{ fontSize: 34, marginBottom: 8 }}>🔒</div>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 6px', color: 'var(--text)' }}>Sign in to see your {what}</h1>
        <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 18px' }}>This page belongs to your account.</p>
        <button type="button" onClick={() => openAuth()} style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, color: 'var(--bg)', background: 'var(--gold)' }}>
          Sign in or join
        </button>
      </div>
    </div>
  );
};

export default SignInFirst;

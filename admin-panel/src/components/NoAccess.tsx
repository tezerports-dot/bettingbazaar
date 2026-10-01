// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a SIGNED-IN staff account sees on a screen it was not given.
 *
 * Every route guard sent this case to `/login`, the same place as a person who
 * is not signed in at all. MEASURED 2026-10-01 by opening the panel as a
 * sub-admin: every screen outside the grant rendered "Sign in — choose your
 * role", with nothing saying the account was signed in and simply lacked the
 * area. A sub-admin following a colleague's link would sign in again, land
 * back on the same form, and conclude the panel was broken (§32 S14: a message
 * the reader cannot act on). This says what is missing, who can grant it, and
 * offers a screen the account CAN use.
 */
import React from 'react';
import { Link } from 'react-router';
import { useAuthStore } from '../services/auth';
import { firstPermittedPath } from './Layout';

const NoAccess: React.FC<{ adminOnly?: boolean }> = ({ adminOnly = false }) => {
  const { admin } = useAuthStore();
  const granted = (admin?.permissions ?? {}) as Record<string, boolean>;
  const elsewhere = admin?.isAdmin
    ? '/'
    : (firstPermittedPath((keys) => keys.some((k) => granted[k] === true))
      ?? (admin?.isQueueManager ? '/queue-manager' : null));

  return (
    <div role="alert" style={{ maxWidth: 560, margin: '48px auto', padding: 24, borderRadius: 12, border: '1px solid var(--line, #334155)', background: 'var(--surface, transparent)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>You don&rsquo;t have access to this screen</h1>
      <p style={{ marginBottom: 16, lineHeight: 1.5 }}>
        {adminOnly
          ? 'Only a full admin can use this screen. It grants authority to other staff accounts, so it cannot be given to a sub-admin.'
          : 'Your account is signed in, but it was not given the area this screen belongs to. Ask an admin to grant it on the Sub-admins screen.'}
      </p>
      {elsewhere
        ? <Link to={elsewhere} style={{ fontWeight: 600 }}>Go to a screen you can use</Link>
        : <p>Your account has not been given any area yet.</p>}
    </div>
  );
};

export default NoAccess;

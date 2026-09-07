// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The inbox for notifications the platform was already writing.
 *
 * ── What this exists to fix ─────────────────────────────────────────────────
 * `notify()` has been persisting rows on real events — an admin blocking or
 * unblocking an account is the live one — and the channel that writes them
 * described its destination as "the existing bell-icon inbox all three panels
 * already read". No panel read it, and there was no route to read it through.
 *
 * So a player was blocked, the platform recorded the explanation meant for
 * them, and they found themselves locked out with no way to see why. That is
 * what this screen is for; the rest is decoration.
 *
 * ── Why the badge polls and the list does not ───────────────────────────────
 * The count is one integer and the thing a player glances at; the list is fifty
 * rows and only read when the panel is open. Fetching the list on a timer to
 * render a number is the kind of read that looks free until there are players.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../../services/apiUrl';

interface Note {
  id: number;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const POLL_MS = 60_000;

const authHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
};

/** ERROR reads as bad news; a blocked account should not look like an INFO notice. */
const toneOf = (type: string) =>
  type === 'ERROR'   ? { dot: '#EF4444', label: 'var(--red, #EF4444)' }
: type === 'WARNING' ? { dot: '#FB8C00', label: '#FB8C00' }
: type === 'SUCCESS' ? { dot: '#22C55E', label: '#22C55E' }
:                      { dot: '#8A93A6', label: 'var(--text3, #8A93A6)' };

const when = (iso: string) => {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

export const NotificationBell: React.FC<{ isAuthenticated: boolean }> = ({ isAuthenticated }) => {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);

  const loadCount = useCallback(async () => {
    if (!isAuthenticated) { setUnread(0); return; }
    try {
      const r = await fetch(apiUrl('/api/user/notifications/unread-count'), { headers: authHeaders() });
      const d = await r.json();
      // A failed poll leaves the last known count alone rather than showing
      // zero — "nothing for you" is a claim, and a network blip is not evidence
      // for it.
      if (d?.success) setUnread(Number(d.unreadCount) || 0);
    } catch { /* keep the last known count */ }
  }, [isAuthenticated]);

  useEffect(() => {
    loadCount();
    if (!isAuthenticated) return undefined;
    const t = setInterval(loadCount, POLL_MS);
    return () => clearInterval(t);
  }, [isAuthenticated, loadCount]);

  const openPanel = async () => {
    setOpen(true); setLoading(true); setError('');
    try {
      const r = await fetch(apiUrl('/api/user/notifications'), { headers: authHeaders() });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.message || 'Could not load notifications');
      setNotes(d.notifications || []);
      setUnread(Number(d.unreadCount) || 0);
    } catch (e: any) {
      setError(e.message || 'Could not load notifications');
    } finally { setLoading(false); }
  };

  /**
   * Acknowledge everything on screen.
   *
   * Deliberately explicit rather than "read on open": a player who taps the
   * bell and closes it without reading should not have the badge cleared for
   * them, because the badge is the only thing that brings them back.
   */
  const markAll = async () => {
    const before = notes;
    setNotes((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    try {
      const r = await fetch(apiUrl('/api/user/notifications/read'), {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.message || 'Could not mark read');
    } catch (e: any) {
      // Put it back. A badge that clears on a failed write tells the player
      // they have seen something they have not.
      setNotes(before);
      setUnread(before.filter((n) => !n.isRead).length);
      setError(e.message || 'Could not mark read');
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!isAuthenticated) return null;

  return (
    <div style={{ position: 'relative' }} ref={panel}>
      <button
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#EAEAEA', cursor: 'pointer', position: 'relative' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{ position: 'absolute', top: 5, right: 4, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: '#EF4444', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #0B0E14' }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, width: 'min(92vw, 340px)', maxHeight: '70vh', overflowY: 'auto', background: '#1A1F2E', border: '1px solid rgba(212,175,55,0.3)', borderRadius: 14, boxShadow: '0 18px 40px -12px rgba(0,0,0,.7)', zIndex: 60 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8A93A6' }}>Notifications</span>
            {notes.some((n) => !n.isRead) && (
              <button onClick={markAll} style={{ background: 'none', border: 'none', color: '#D4AF37', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                Mark all read
              </button>
            )}
          </div>

          {loading && <p style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#8A93A6' }}>Loading…</p>}
          {error && <p style={{ padding: '12px 14px', fontSize: 11, color: '#EF4444' }}>{error}</p>}

          {!loading && !error && notes.length === 0 && (
            <p style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12, color: '#8A93A6', lineHeight: 1.5 }}>
              Nothing yet.<br />Account notices appear here.
            </p>
          )}

          {notes.map((n) => {
            const tone = toneOf(n.type);
            return (
              <div key={n.id} style={{ display: 'flex', gap: 10, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.05)', background: n.isRead ? 'transparent' : 'rgba(212,175,55,0.06)' }}>
                <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', marginTop: 5, background: n.isRead ? 'transparent' : tone.dot, border: n.isRead ? '1px solid rgba(255,255,255,.18)' : 'none' }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 12.5, fontWeight: n.isRead ? 600 : 800, color: n.isRead ? '#C7CCD6' : '#EAEAEA' }}>{n.title}</p>
                  {/* The message is the point — it is where "why" lives. */}
                  {n.message && <p style={{ margin: '3px 0 0', fontSize: 11.5, lineHeight: 1.45, color: '#9AA3B2' }}>{n.message}</p>}
                  <p style={{ margin: '4px 0 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: tone.label }}>{when(n.createdAt)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;

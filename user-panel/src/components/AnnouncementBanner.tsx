// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the platform is telling everyone, on the screen everyone is on.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `announcements` has an admin page that creates, edits, expires and deletes
 * rows, a `GET /api/announcements` that serves the live ones, and — until this
 * component — no screen in the player panel that read it. An operator wrote an
 * announcement, the platform stored it, and nobody was ever shown it.
 *
 * That is the third instance of the same shape in this codebase (§28: a
 * backend feature with no UI is not shipped): the notification inbox and the
 * app-download links were the first two. The pattern is always an admin
 * surface finished and a player surface assumed.
 *
 * ── Unauthenticated on purpose ──────────────────────────────────────────────
 * The route takes no token. An announcement is how the platform says "deposits
 * are paused for an hour", and the people who most need to read that are the
 * ones who cannot sign in — so it renders signed out too, and the fetch
 * carries no credentials.
 *
 * ── Dismissal is per-viewer and per-announcement ────────────────────────────
 * Stored in `localStorage` by id, which is exactly what browser storage is for
 * (a per-viewer convenience, not state anything else reads back). Wrapped in
 * try/catch because a private window throws on access, and a banner that
 * cannot remember a dismissal is still better than a page that will not
 * render. Expiry is the SERVER's — it is enforced by the read, so an expired
 * announcement simply stops arriving and nothing here has to track time.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../services/apiUrl';

interface Announcement {
  announcementId: string;
  title: string;
  body: string;
  kind: 'INFO' | 'WARNING' | 'CRITICAL' | 'PROMO';
  priority: number;
}

/** Live announcements change on an operator's timescale, not a player's. */
const POLL_MS = 5 * 60_000;
const DISMISSED_KEY = 'dismissed_announcements';

const readDismissed = (): string[] => {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'); } catch { return []; }
};

/** CRITICAL must not read like a promo. The tone is the message. */
const TONE: Record<Announcement['kind'], { bg: string; line: string; ink: string }> = {
  CRITICAL: { bg: 'rgba(243,106,106,.12)', line: 'rgba(243,106,106,.42)', ink: '#ff9a9a' },
  WARNING:  { bg: 'rgba(239,176,62,.12)',  line: 'rgba(239,176,62,.42)',  ink: '#f0c46a' },
  PROMO:    { bg: 'rgba(var(--brand-primary-rgb), .12)', line: 'rgba(var(--brand-primary-rgb), .42)', ink: 'var(--gold-ink, var(--brand-primary))' },
  INFO:     { bg: 'rgba(90,160,242,.12)',  line: 'rgba(90,160,242,.42)',  ink: '#8fbcf7' },
};

const AnnouncementBanner: React.FC = () => {
  const [live, setLive] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/announcements'));
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.announcements)) setLive(data.announcements);
    } catch { /* an announcement failing to load must never break the page */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-50))); } catch { /* private mode */ }
  };

  // The server already orders by priority then recency; the top one is the one
  // that matters. Showing a stack of banners pushes the game off the screen.
  const showing = live.filter((a) => !dismissed.includes(a.announcementId))[0];
  if (!showing) return null;
  const tone = TONE[showing.kind] ?? TONE.INFO;

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0 14px 10px',
        padding: '10px 12px', borderRadius: 12,
        background: tone.bg, border: `1px solid ${tone.line}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: tone.ink }}>{showing.title}</div>
        {showing.body ? (
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
            {showing.body}
          </div>
        ) : null}
      </div>
      <button
        onClick={() => dismiss(showing.announcementId)}
        aria-label="Dismiss announcement"
        style={{
          flex: 'none', width: 24, height: 24, borderRadius: '50%', cursor: 'pointer',
          border: '1px solid var(--line)', background: 'transparent', color: 'var(--text3)', fontSize: 12,
        }}
      >
        ✕
      </button>
    </div>
  );
};

export default AnnouncementBanner;

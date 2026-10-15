// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Pull to refresh (owner, 2026-10-15): drag the page down from its top and let
 * go to reload the app, as a phone's browser does. The installed web app, the
 * Android app and Telegram's in-app browser have no such gesture of their own,
 * and the page itself turns the browser's off (`overscroll-behavior: none`,
 * index.css), so the shell draws its own on <main>, the one scroller.
 *
 * A refresh asks the service worker for a newer build first, then reloads:
 * the page is fetched from the network (service-worker.js serves pages
 * network-first), so the player gets the latest app and the latest figures.
 * Touch screens only; a horizontal swipe (game tabs, carousels) or a drag
 * inside anything already scrolled down is left alone.
 */
import React, { useEffect, useRef, useState } from 'react';

/** How far (px, after resistance) the page must be pulled to refresh on release. */
export const PULL_THRESHOLD = 70;
/** The furthest the indicator travels. */
const PULL_MAX = 110;
/** Finger travel is halved, so the page feels held. */
const RESISTANCE = 0.5;
/** How long a refresh waits for the service worker before reloading anyway. */
const UPDATE_WAIT_MS = 3000;

/** Ask for a newer build, let a waiting one take over, then reload. */
export async function refreshApp(): Promise<void> {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      await Promise.race([reg.update().catch(() => undefined), new Promise((r) => setTimeout(r, UPDATE_WAIT_MS))]);
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    }
  } catch { /* a refresh still reloads */ }
  window.location.reload();
}

/** Whether something between the touched element and the scroller is scrolled down already. */
function innerScrolled(target: EventTarget | null, scroller: HTMLElement): boolean {
  for (let el = target as HTMLElement | null; el && el !== scroller; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

function touchScreen(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/**
 * Wires the gesture to `scrollerRef` and returns how far it is pulled and
 * whether a refresh is under way. `onRefresh` defaults to `refreshApp`.
 */
export function usePullToRefresh(
  scrollerRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void = refreshApp,
): { pull: number; refreshing: boolean } {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !touchScreen()) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    let busy = false;

    const reset = () => { start = null; pulling = false; distance = 0; setPull(0); };
    const onStart = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || el.scrollTop > 0 || innerScrolled(e.target, el)) { start = null; return; }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      pulling = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!pulling) {
        // Decide once, on the first clear movement: down and more down than sideways.
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (dy <= 0 || Math.abs(dx) > dy || el.scrollTop > 0) { start = null; return; }
        pulling = true;
      }
      if (e.cancelable) e.preventDefault(); // hold the page still while pulling
      distance = Math.max(0, Math.min(PULL_MAX, dy * RESISTANCE));
      setPull(distance);
    };
    const onEnd = () => {
      if (!pulling) { start = null; return; }
      if (distance >= PULL_THRESHOLD) {
        busy = true;
        setRefreshing(true);
        setPull(PULL_THRESHOLD);
        start = null; pulling = false;
        Promise.resolve(refreshRef.current()).catch(() => undefined).finally(() => {
          busy = false; setRefreshing(false); reset();
        });
      } else {
        reset();
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', reset);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', reset);
    };
  }, [scrollerRef]);

  return { pull, refreshing };
}

/** The circle that follows the pull: an arrow that turns at the threshold, then a spinner. */
export const PullIndicator: React.FC<{ pull: number; refreshing: boolean }> = ({ pull, refreshing }) => {
  if (pull <= 0 && !refreshing) return null;
  const ready = pull >= PULL_THRESHOLD;
  return (
    <div aria-hidden={!refreshing} style={{
      position: 'sticky', top: 0, height: 0, zIndex: 30, display: 'flex', justifyContent: 'center', pointerEvents: 'none',
    }}>
      <div role={refreshing ? 'status' : undefined} aria-label={refreshing ? 'Refreshing' : undefined}
        data-testid="pull-indicator"
        style={{
          width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface2)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)',
          color: 'var(--gold-ink)', transform: `translateY(${pull - 30}px)`,
          transition: pull === 0 || refreshing ? 'transform .2s ease' : 'none', opacity: Math.min(1, pull / 40 + (refreshing ? 1 : 0)),
        }}>
        {refreshing ? (
          <span className="bb-ptr-spin" style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent' }} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: `rotate(${ready ? 180 : 0}deg)`, transition: 'transform .15s ease' }}>
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        )}
      </div>
      <style>{'@keyframes bb-ptr-spin{to{transform:rotate(360deg)}}.bb-ptr-spin{animation:bb-ptr-spin .7s linear infinite}'}</style>
    </div>
  );
};

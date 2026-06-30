// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// §11: Public SSE events: new_cycle, cycle_result, cycle_phase, cycle_snapshot, cycle_history, system_config, branding, branding_updated
// §11: Private admin SSE events: new_order, queue_order_update, kyc_update, queue_snapshot,
//      admin_cycle_update, admin_new_cycle, admin_cycle_result (via /api/sse/admin/events)

// §14: same-origin monorepo deployment — VITE_API_URL only required after split (step 3)
const _sseApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
const _sseIsLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_URL = _sseApiUrl || (_sseIsLocal ? 'http://localhost:8080' : window.location.origin);

const PUBLIC_SSE_URL  = `${API_URL}/api/sse/events`;
const ADMIN_SSE_URL   = `${API_URL}/api/sse/admin/events`;

// §1: Admin auth token storage key = 'admin-auth' (Zustand persist, state.token)
const getAdminToken = (): string | null => {
  try {
    const raw = localStorage.getItem('admin-auth');
    return raw ? JSON.parse(raw)?.state?.token ?? null : null;
  } catch { return null; }
};

type Handler = (data: any) => void;

class SSEService {
  private publicSse: EventSource | null = null;
  private adminSse:  EventSource | null = null;
  private listeners: Map<string, Set<Handler>> = new Map();

  connect() {
    this._connectPublic();
    this._connectAdmin();
  }

  private _connectPublic() {
    if (this.publicSse && this.publicSse.readyState !== EventSource.CLOSED) return;
    try {
      this.publicSse = new EventSource(PUBLIC_SSE_URL);
      const publicEvents = [
        'cycle_snapshot', 'new_cycle', 'cycle_result', 'cycle_phase',
        'cycle_history', 'system_config', 'branding', 'branding_updated',
      ];
      for (const ev of publicEvents) {
        this.publicSse.addEventListener(ev, (e: MessageEvent) => {
          try { this.listeners.get(ev)?.forEach(cb => cb(JSON.parse(e.data))); } catch { /* ignore */ }
        });
      }
      this.publicSse.onopen  = () => console.log('📡 Admin SSE (public): Connected');
      this.publicSse.onerror = () => console.warn('📡 Admin SSE (public): Reconnecting...');
    } catch (err) { console.error('📡 Admin SSE (public) failed:', err); }
  }

  private _connectAdmin() {
    if (this.adminSse && this.adminSse.readyState !== EventSource.CLOSED) return;
    const token = getAdminToken();
    if (!token) return; // not logged in yet
    try {
      this.adminSse = new EventSource(`${ADMIN_SSE_URL}?token=${encodeURIComponent(token)}`);
      // §11 private admin events — all confirmed emitted by backend
      const adminEvents = [
        'new_order', 'queue_order_update', 'kyc_update', 'queue_snapshot',
        'admin_cycle_update', 'admin_new_cycle', 'admin_cycle_result',
        'merchant_status_changed', 'merchant_limits_updated',
      ];
      for (const ev of adminEvents) {
        this.adminSse.addEventListener(ev, (e: MessageEvent) => {
          try { this.listeners.get(ev)?.forEach(cb => cb(JSON.parse(e.data))); } catch { /* ignore */ }
        });
      }
      this.adminSse.onopen  = () => console.log('📡 Admin SSE (private): Connected');
      this.adminSse.onerror = () => console.warn('📡 Admin SSE (private): Reconnecting...');
    } catch (err) { console.error('📡 Admin SSE (private) failed:', err); }
  }

  disconnect() {
    if (this.publicSse) { this.publicSse.close(); this.publicSse = null; }
    if (this.adminSse)  { this.adminSse.close();  this.adminSse  = null; }
  }

  on(event: string, handler: Handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Handler) {
    this.listeners.get(event)?.delete(handler);
  }

  isConnected(): boolean {
    return this.publicSse?.readyState === EventSource.OPEN;
  }
}

export const sseService = new SSEService();
export default sseService;


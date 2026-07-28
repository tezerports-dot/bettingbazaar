// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// §11: Public SSE events: system_config, branding, branding_updated
// §11: Private merchant SSE events: merchant_orders_snapshot, new_order, order_update, merchant_stats
//      (via /api/sse/merchant/events?token=<merchantToken>)
// §1: merchantToken is the sole auth token storage key for merchant panel

const getAPIBase = (): string => {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return (import.meta.env.VITE_API_URL as string) || 'http://localhost:8080';
  }
  // §14: same-origin monorepo deployment — VITE_API_URL only required after split (step 3)
  return (import.meta.env.VITE_API_URL as string) || window.location.origin;
};

const PUBLIC_SSE_URL   = `${getAPIBase()}/api/sse/events`;
const MERCHANT_SSE_URL = `${getAPIBase()}/api/sse/merchant/events`;

// §1: merchantToken — sole auth key for merchant panel
const getMerchantToken = (): string | null => localStorage.getItem('merchantToken');

type Handler = (data: any) => void;

class SSEService {
  private publicSse:   EventSource | null = null;
  private merchantSse: EventSource | null = null;
  private listeners: Map<string, Set<Handler>> = new Map();

  connect() {
    this._connectPublic();
    this._connectMerchant();
  }

  private _connectPublic() {
    if (this.publicSse && this.publicSse.readyState !== EventSource.CLOSED) return;
    try {
      this.publicSse = new EventSource(PUBLIC_SSE_URL);
      const publicEvents = ['system_config', 'branding', 'branding_updated'];
      for (const ev of publicEvents) {
        this.publicSse.addEventListener(ev, (e: MessageEvent) => {
          try { this.listeners.get(ev)?.forEach(cb => cb(JSON.parse(e.data))); } catch { /* ignore */ }
        });
      }
      this.publicSse.onopen  = () => console.log('📡 Merchant SSE (public): Connected');
      this.publicSse.onerror = () => console.warn('📡 Merchant SSE (public): Reconnecting...');
    } catch (err) { console.error('📡 Merchant SSE (public) failed:', err); }
  }

  private _connectMerchant() {
    if (this.merchantSse && this.merchantSse.readyState !== EventSource.CLOSED) return;
    const token = getMerchantToken();
    if (!token) return; // not logged in yet
    try {
      this.merchantSse = new EventSource(`${MERCHANT_SSE_URL}?token=${encodeURIComponent(token)}`);
      // §11 private merchant events. `merchant_stats` was listed here and in
      // GOVERNANCE §11, but no backend file emits that name — it was a dead
      // subscription (verified 2026-07-27). `merchant_score_update` is the one
      // the backend actually sends after a completed order.
      const merchantEvents = [
        'merchant_orders_snapshot', 'new_order', 'order_update', 'merchant_score_update',
      ];
      for (const ev of merchantEvents) {
        this.merchantSse.addEventListener(ev, (e: MessageEvent) => {
          try { this.listeners.get(ev)?.forEach(cb => cb(JSON.parse(e.data))); } catch { /* ignore */ }
        });
      }
      this.merchantSse.onopen  = () => console.log('📡 Merchant SSE (private): Connected');
      this.merchantSse.onerror = () => console.warn('📡 Merchant SSE (private): Reconnecting...');
    } catch (err) { console.error('📡 Merchant SSE (private) failed:', err); }
  }

  disconnect() {
    if (this.publicSse)   { this.publicSse.close();   this.publicSse   = null; }
    if (this.merchantSse) { this.merchantSse.close(); this.merchantSse = null; }
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


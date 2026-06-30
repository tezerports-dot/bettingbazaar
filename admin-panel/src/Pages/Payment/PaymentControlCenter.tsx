// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, RefreshCw, TestTube, Zap, Server, CheckCircle, AlertCircle, AlertTriangle, Shield } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

// ── DisputeResolutionPanel (Section 5A) ───────────────────────────────────────
// Pulls all DISPUTED orders, shows UTR / proof / parties, allows release or refund.
const DisputeResolutionPanel: React.FC = () => {
  const [disputed, setDisputed] = useState<any[]>([]);
  const [loading, setLoading]   = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/admin/queue/orders?status=DISPUTED&limit=50');
      setDisputed(r.data?.orders || r.data?.data || []);
    } catch { toast.error('Failed to load disputed orders'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const resolve = async (orderId: string, resolution: 'release' | 'refund') => {
    const reason = window.prompt(
      `Admin resolve: ${resolution.toUpperCase()}\n\nEnter reason for this decision:`
    );
    if (!reason?.trim()) return;
    setResolving(orderId);
    try {
      await api.post(`/api/admin/queue/payment-orders/${orderId}/resolve`, {
        resolution, reason: reason.trim(),
      });
      toast.success(`Dispute ${resolution === 'release' ? 'released' : 'refunded'} successfully`);
      await load();
    } catch (e: any) {
      toast.error(e.response?.data?.message || `Failed to ${resolution}`);
    } finally { setResolving(null); }
  };

  if (disputed.length === 0 && !loading) return null;

  return (
    <div className="card border border-orange-500/30 bg-orange-500/5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2 text-orange-400">
          <AlertTriangle size={16} />
          Disputed Orders ({disputed.length})
        </h3>
        <button onClick={load} disabled={loading} className="btn-secondary text-xs flex items-center gap-1">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-4"><RefreshCw className="animate-spin text-orange-400" size={20} /></div>
      ) : (
        <div className="space-y-3">
          {disputed.map((order: any) => (
            <div key={order._id} className="bg-dark-800 border border-orange-500/20 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xs bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded-full font-medium">DISPUTED</span>
                  <span className="text-xs text-gray-400 ml-2">{order.type === 'DEPOSIT' ? '⬇️ Buy' : '⬆️ Sell'}</span>
                  <p className="text-sm text-gray-300 mt-1 font-mono">{order.orderId}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-white">₹{(order.fiatAmount || 0).toLocaleString('en-IN')}</p>
                  <p className="text-xs text-gray-400">{(order.tokenAmount || 0).toLocaleString()} tokens</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-dark-700 rounded-lg p-2">
                  <p className="text-gray-500 mb-0.5">User</p>
                  <p className="text-gray-200">{order.userId?.username || order.userId?.mobile || String(order.userId).slice(-6)}</p>
                </div>
                <div className="bg-dark-700 rounded-lg p-2">
                  <p className="text-gray-500 mb-0.5">Merchant</p>
                  <p className="text-gray-200">{order.merchantId?.username || order.merchantSnapshot?.merchantName || String(order.merchantId || '—').slice(-6)}</p>
                </div>
              </div>

              {order.disputeRaisedBy && (
                <p className="text-xs text-orange-300">
                  Raised by: <strong>{order.disputeRaisedBy}</strong>
                  {order.disputeRaisedAt && <span className="text-gray-500 ml-1">· {new Date(order.disputeRaisedAt).toLocaleString('en-IN')}</span>}
                </p>
              )}
              {order.disputeReason && (
                <p className="text-xs text-gray-400 italic">"{order.disputeReason}"</p>
              )}

              {order.utrNumber && (
                <p className="text-xs text-gray-300">UTR: <span className="font-mono text-white">{order.utrNumber}</span></p>
              )}
              {order.proofScreenshot && (
                <a href={order.proofScreenshot} target="_blank" rel="noreferrer">
                  <img src={order.proofScreenshot} alt="proof" className="w-20 h-20 object-cover rounded border border-white/20 hover:opacity-80 cursor-pointer" />
                </a>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => resolve(order._id, 'release')}
                  disabled={resolving === order._id}
                  className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white font-semibold py-2 rounded-lg text-xs transition-colors"
                >
                  ✅ Release to User
                </button>
                <button
                  onClick={() => resolve(order._id, 'refund')}
                  disabled={resolving === order._id}
                  className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-semibold py-2 rounded-lg text-xs transition-colors"
                >
                  ↩️ Refund to Merchant
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const PaymentControlCenter: React.FC = () => {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      // FIX-11: route is mounted at /api/payment, admin sub-route is /admin/config
      const r = await api.get('/api/payment/admin/config');
      if (r.data.success) setCfg(r.data.config);
    } catch { toast.error('Failed to load config'); }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/api/payment/admin/config', cfg);
      if (r.data.success) { setCfg(r.data.config); toast.success('Config saved!'); }
    } catch { toast.error('Save failed'); } finally { setSaving(false); }
  };

  const testGateway = async () => {
    setTesting(true);
    try {
      const r = await api.post('/api/payment/admin/test-gateway');
      toast.success(r.data.message || 'Gateway reachable');
    } catch (e: any) { toast.error(e.response?.data?.message || 'Test failed'); } finally { setTesting(false); }
  };

  const set = (key: string, val: any) => setCfg((p: any) => ({ ...p, [key]: val }));

  if (!cfg) return <div className="flex justify-center py-20"><RefreshCw className="animate-spin text-yellow-400" size={28} /></div>;

  const isP2P = cfg.activeMode === 'P2P' || !cfg.activeMode;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Payment System Control</h1>
          <p className="text-gray-400 text-sm mt-1">
            Switch between P2P merchant system and payment gateway API.
            All deposits and withdrawals run through merchants — gateway is a future option.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="btn-secondary flex items-center gap-2"><RefreshCw size={14} />Refresh</button>
          <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2">
            <Save size={14} />{saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Big toggle */}
      <div className="grid grid-cols-2 gap-4">
        {}
        <button
          onClick={() => set('activeMode', 'P2P')}
          className={`card text-left transition-all border-2 ${isP2P ? 'border-green-500 bg-green-500/5' : 'border-dark-600 opacity-60 hover:opacity-80'}`}
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isP2P ? 'bg-green-500/20' : 'bg-dark-600'}`}>
                <Server size={22} className={isP2P ? 'text-green-400' : 'text-gray-500'} />
              </div>
              <div>
                <h3 className="font-bold text-lg">P2P Merchant System</h3>
                <p className="text-xs text-gray-400">Current active system</p>
              </div>
            </div>
            {isP2P && <CheckCircle size={20} className="text-green-400 flex-shrink-0" />}
          </div>
          <p className="text-sm text-gray-300 leading-relaxed">
            All deposits and withdrawals are handled by verified merchants.
            Users create an order → Queue Manager assigns a merchant → Merchant completes the payment.
            Zero gateway fees. Fully human-verified.
          </p>
          {isP2P && (
            <div className="mt-3 flex items-center gap-1.5 text-green-400 text-xs font-medium">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              ACTIVE
            </div>
          )}
        </button>

        {/* Gateway Card */}
        <button
          onClick={() => set('activeMode', 'GATEWAY')}
          className={`card text-left transition-all border-2 ${!isP2P ? 'border-yellow-500 bg-yellow-500/5' : 'border-dark-600 opacity-60 hover:opacity-80'}`}
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${!isP2P ? 'bg-yellow-500/20' : 'bg-dark-600'}`}>
                <Zap size={22} className={!isP2P ? 'text-yellow-400' : 'text-gray-500'} />
              </div>
              <div>
                <h3 className="font-bold text-lg">Payment Gateway API</h3>
                <p className="text-xs text-gray-400">Future integration</p>
              </div>
            </div>
            {!isP2P && <CheckCircle size={20} className="text-yellow-400 flex-shrink-0" />}
          </div>
          <p className="text-sm text-gray-300 leading-relaxed">
            Route deposits through a payment gateway API (Razorpay, Cashfree, etc.).
            Users pay instantly via UPI/card — no merchant needed. Configure API keys below.
            <span className="text-yellow-400"> Requires API contract with provider.</span>
          </p>
          {!isP2P && (
            <div className="mt-3 flex items-center gap-1.5 text-yellow-400 text-xs font-medium">
              <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
              ACTIVE
            </div>
          )}
        </button>
      </div>

      {/* Gateway config — only relevant when gateway is selected */}
      <div className={`card space-y-5 transition-opacity ${isP2P ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-yellow-400" />
          <h3 className="font-semibold">Gateway API Configuration</h3>
          {isP2P && <span className="text-xs text-gray-500 ml-auto">Switch to Gateway mode to edit</span>}
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-2 block">Provider</label>
          <div className="flex gap-3 flex-wrap">
            {['RAZORPAY','CASHFREE','PAYU','EKQR','CUSTOM'].map(p => (
              <button key={p} onClick={() => set('gatewayProvider', p)}
                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all
                  ${cfg.gatewayProvider === p ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400' : 'border-dark-600 text-gray-400 hover:border-dark-500'}`}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {[
            { key: 'gatewayApiKey',        label: 'API Key',        ph: 'pk_live_…' },
            { key: 'gatewayApiSecret',     label: 'API Secret',     ph: 'sk_live_…' },
            { key: 'gatewayMerchantId',    label: 'Merchant ID',    ph: 'MID…' },
            { key: 'gatewayWebhookSecret', label: 'Webhook Secret', ph: 'whsec_…' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-xs text-gray-400 mb-1 block">{f.label}</label>
              <input
                type={f.key.toLowerCase().includes('secret') ? 'password' : 'text'}
                value={cfg[f.key] || ''}
                onChange={e => set(f.key, e.target.value)}
                placeholder={f.ph}
                className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white focus:border-yellow-500/50 outline-none"
              />
            </div>
          ))}
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            Webhook / Callback URL
            <span className="text-gray-600 ml-2">(paste this in your gateway dashboard)</span>
          </label>
          <div className="flex gap-2">
            <input
              readOnly
              value={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/payment/gateway-webhook`}
              className="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-400 font-mono"
            />
            <button onClick={() => { navigator.clipboard.writeText(window.location.origin + '/api/payment/gateway-webhook'); toast.success('Copied!'); }}
              className="btn-secondary text-xs">Copy</button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={testGateway} disabled={testing || isP2P} className="btn-secondary flex items-center gap-2">
            <TestTube size={14} />{testing ? 'Testing…' : 'Test Connection'}
          </button>
          <AlertCircle size={14} className="text-gray-500" />
          <span className="text-xs text-gray-500">Gateway integration requires backend webhook handler for chosen provider</span>
        </div>
      </div>

      {}
      {isP2P && (
        <div className="card border border-green-500/20 bg-green-500/5 space-y-2">
          <h3 className="font-semibold flex items-center gap-2 text-green-400"><CheckCircle size={16}/>P2P System Status</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div><p className="text-gray-400 text-xs mb-0.5">Merchant matching</p><p className="font-medium text-green-400">Auto-assign (instant)</p></div>
            <div><p className="text-gray-400 text-xs mb-0.5">Deposits</p><p className="font-medium">User → Merchant (15-min window)</p></div>
            <div><p className="text-gray-400 text-xs mb-0.5">Withdrawals</p><p className="font-medium">Merchant → User bank (instant confirm)</p></div>
          </div>
          <p className="text-xs text-gray-500">To manage orders and disputes, go to <strong className="text-white">Queue Dashboard</strong>. To manage merchant scoring limits, go to <strong className="text-white">Merchants</strong>.</p>
        </div>
      )}

      {/* Dispute Resolution Panel (Section 5A) */}
      <DisputeResolutionPanel />
    </div>
  );
};

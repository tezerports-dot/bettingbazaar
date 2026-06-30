// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import React, { useEffect, useState, useRef } from 'react';
import {
  AlertTriangle, CheckCircle, RefreshCw, Send,
  MessageSquare, Scale, Image as ImgIcon, Clock,
} from 'lucide-react';
import { Modal } from '../../components/Modal';
import { StatusBadge } from '../../components/StatusBadge';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Dispute {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  fiatAmount: number;
  status: string;
  createdAt: string;
  userId?: { username: string; mobile: string };
  merchantId?: { username: string; mobile: string };
  disputeReason?: string;
  disputeResolution?: string;
  disputeDecision?: string;
  disputeResolvedAt?: string;
  disputeResolvedBy?: { username: string };
  utrNumber?: string;
  proofScreenshot?: string;
}

interface ChatMsg {
  id: string;
  senderType: 'USER' | 'MERCHANT' | 'SYSTEM';
  senderName: string;
  text: string;
  message?: string;
  attachmentUrl?: string | null;
  isSystem: boolean;
  timestamp: number | string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (ts: number | string) => {
  try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

const fmtDate = (ts: number | string) => {
  try { return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
};

// ── Main component ────────────────────────────────────────────────────────────
export const DisputeManager: React.FC = () => {
  const [disputes, setDisputes]           = useState<Dispute[]>([]);
  const [isLoading, setIsLoading]         = useState(true);
  const [selected, setSelected]           = useState<Dispute | null>(null);
  const [activeTab, setActiveTab]         = useState<'chat' | 'resolve'>('chat');

  
  const [chatMsgs, setChatMsgs]           = useState<ChatMsg[]>([]);
  const [chatLoading, setChatLoading]     = useState(false);
  const [adminMsg, setAdminMsg]           = useState('');
  const [sendingMsg, setSendingMsg]       = useState(false);
  const chatBottomRef                     = useRef<HTMLDivElement>(null);

  // Resolve tab state
  const [decision, setDecision]           = useState('RELEASE_TO_USER');
  const [resolution, setResolution]       = useState('');
  const [refundAmt, setRefundAmt]         = useState('');
  const [penaltyAmt, setPenaltyAmt]       = useState('');
  const [isSaving, setIsSaving]           = useState(false);

  const [filterStatus, setFilterStatus]   = useState('all');

  // ── Load disputes list ────────────────────────────────────────────────────
  const load = async () => {
    setIsLoading(true);
    try {
      const res = await api.get<any>('/api/admin/dispute-orders', { params: { status: filterStatus } });
      setDisputes(res.data?.disputes || []);
    } catch { toast.error('Failed to load disputes'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { load(); }, [filterStatus]);

  
  const loadChat = async (d: Dispute) => {
    setChatLoading(true);
    setChatMsgs([]);
    try {
      const res = await api.get<any>(`/api/admin/dispute-orders/${d._id}/chat`);
      const msgs: ChatMsg[] = (res.data?.messages || []).map((m: any) => ({
        id:            m.id || m._id,
        senderType:    m.senderType,
        senderName:    m.senderName || m.senderType,
        text:          m.text || m.message || '',
        attachmentUrl: m.attachmentUrl || null,
        isSystem:      m.isSystem || m.senderType === 'SYSTEM',
        timestamp:     m.timestamp,
      }));
      setChatMsgs(msgs);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch { toast.error('Failed to load chat evidence'); }
    finally { setChatLoading(false); }
  };

  // ── Open dispute modal ────────────────────────────────────────────────────
  const open = async (d: Dispute) => {
    try {
      const res = await api.get<any>(`/api/admin/dispute-orders/${d._id}`);
      setSelected(res.data?.dispute || d);
    } catch { setSelected(d); }
    setActiveTab('chat');
    setDecision('RELEASE_TO_USER');
    setResolution('');
    setRefundAmt('');
    setPenaltyAmt('');
    await loadChat(d);
  };

  // ── Send admin mediation message ──────────────────────────────────────────
  const handleSendAdminMsg = async () => {
    if (!adminMsg.trim() || !selected) return;
    setSendingMsg(true);
    try {
      const res = await api.post<any>(`/api/admin/dispute-orders/${selected._id}/chat`, { message: adminMsg.trim() });
      const m = res.data?.message;
      if (m) {
        setChatMsgs(prev => [...prev, {
          id: m.id || String(Date.now()), senderType: 'SYSTEM',
          senderName: m.senderName || 'Admin', text: m.text || m.message || '',
          attachmentUrl: null, isSystem: true, timestamp: m.timestamp || Date.now(),
        }]);
        setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
      setAdminMsg('');
      toast.success('Message sent to user and merchant');
    } catch { toast.error('Failed to send message'); }
    finally { setSendingMsg(false); }
  };

  // ── Resolve dispute ───────────────────────────────────────────────────────
  const handleResolve = async () => {
    if (!selected || !resolution.trim()) { toast.error('Resolution notes required'); return; }
    setIsSaving(true);
    try {
      await api.post(`/api/admin/dispute-orders/${selected._id}/resolve`, {
        decision,
        resolution: resolution.trim(),
        refundAmount:  refundAmt  ? parseFloat(refundAmt)  : undefined,
        penaltyAmount: penaltyAmt ? parseFloat(penaltyAmt) : undefined,
      });
      toast.success('Dispute resolved');
      setSelected(null);
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to resolve'); }
    finally { setIsSaving(false); }
  };

  const handleEscalate = async (disputeId: string) => {
    try {
      await api.post(`/api/admin/dispute-orders/${disputeId}/escalate`, { notes: 'Escalated by admin' });
      toast.success('Escalated'); load();
    } catch { toast.error('Failed to escalate'); }
  };

  
  const renderBubble = (msg: ChatMsg) => {
    const isSystem   = msg.isSystem || msg.senderType === 'SYSTEM';
    const isMerchant = msg.senderType === 'MERCHANT';
    const text       = msg.text || msg.message || '';

    if (isSystem) return (
      <div key={msg.id} className="flex justify-center my-3">
        <div className="bg-blue-900/30 text-blue-300 px-4 py-2 rounded-full text-xs border border-blue-700/40 max-w-sm text-center">
          {text}
        </div>
      </div>
    );

    return (
      <div key={msg.id} className={`flex mb-3 ${isMerchant ? 'justify-end' : 'justify-start'}`}>
        <div className="max-w-xs lg:max-w-md">
          <p className={`text-[10px] mb-0.5 px-1 ${isMerchant ? 'text-right text-blue-400' : 'text-left text-gray-400'}`}>
            {msg.senderName || msg.senderType}
          </p>
          <div className={`rounded-lg px-3 py-2 text-sm ${isMerchant ? 'bg-blue-600 text-white' : 'bg-dark-600 text-gray-100'}`}>
            {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
            {msg.attachmentUrl && (
              <div className="mt-2">
                <img
                  src={msg.attachmentUrl} alt="Attachment"
                  className="rounded max-w-full cursor-pointer hover:opacity-90"
                  onClick={() => window.open(msg.attachmentUrl!, '_blank')}
                />
                <p className="text-[10px] mt-1 opacity-70 flex items-center gap-1">
                  <ImgIcon className="h-3 w-3" /> Payment proof — tap to open
                </p>
              </div>
            )}
            <p className={`text-[10px] mt-1 ${isMerchant ? 'text-blue-200' : 'text-gray-500'}`}>
              {fmt(msg.timestamp)}
            </p>
          </div>
        </div>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dispute Manager</h1>
          <p className="text-gray-400 text-sm mt-1">Resolve payment order disputes — read full chat evidence before deciding</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input text-sm">
            <option value="all">All Disputes</option>
            <option value="DISPUTED">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="ESCALATED">Escalated</option>
          </select>
          <button onClick={load} className="p-2 hover:bg-dark-700 rounded-lg"><RefreshCw size={16} /></button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading disputes…</div>
      ) : disputes.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <CheckCircle size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-lg">No disputes found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map(d => (
            <div key={d._id} className="bg-dark-800 rounded-xl p-4 border border-dark-700">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-yellow-500" />
                    <span className="font-mono text-sm text-gray-300">{d.orderId}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${d.type === 'DEPOSIT' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {d.type}
                    </span>
                  </div>
                  <p className="text-sm"><span className="text-gray-400">User: </span>{d.userId?.username} ({d.userId?.mobile})</p>
                  <p className="text-sm"><span className="text-gray-400">Merchant: </span>{d.merchantId?.username}</p>
                  {d.disputeReason && <p className="text-xs text-yellow-400">Reason: {d.disputeReason}</p>}
                  <p className="text-xs text-gray-500">{fmtDate(d.createdAt)}</p>
                </div>
                <div className="text-right space-y-2">
                  <p className="text-xl font-bold">{formatters.currency(d.fiatAmount || d.amount)}</p>
                  <StatusBadge status={d.status} type="order" />
                  {d.status === 'DISPUTED' && (
                    <div className="flex gap-2">
                      <button onClick={() => open(d)}
                        className="px-3 py-1.5 bg-gold-500 text-black text-xs font-semibold rounded-lg hover:bg-gold-400">
                        View Chat + Resolve
                      </button>
                      <button onClick={() => handleEscalate(d._id)}
                        className="px-3 py-1.5 bg-dark-600 text-gray-300 text-xs font-semibold rounded-lg hover:bg-dark-500">
                        Escalate
                      </button>
                    </div>
                  )}
                  {d.status === 'RESOLVED' && d.disputeDecision && (
                    <p className="text-xs text-green-400">Decision: {d.disputeDecision.replace(/_/g, ' ')}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Dispute Modal ─────────────────────────────────────────────────── */}
      {selected && (
        <Modal isOpen onClose={() => setSelected(null)} title={`Dispute — ${selected.orderId}`}>
          <div className="flex flex-col" style={{ height: '70vh' }}>
            {/* Order summary */}
            <div className="bg-dark-700 rounded-lg p-3 text-sm space-y-1 mb-3 flex-shrink-0">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="flex justify-between"><span className="text-gray-400">Amount</span><span className="font-bold">{formatters.currency(selected.fiatAmount || selected.amount)}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Type</span><span>{selected.type}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">User</span><span>{selected.userId?.username} ({selected.userId?.mobile})</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Merchant</span><span>{selected.merchantId?.username}</span></div>
              </div>
              {selected.disputeReason && (
                <div className="mt-1 text-yellow-400 text-xs">⚠ Reason: {selected.disputeReason}</div>
              )}
              {selected.utrNumber && (
                <div className="text-xs"><span className="text-gray-400">UTR: </span><span className="font-mono text-green-400">{selected.utrNumber}</span></div>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-dark-600 mb-3 flex-shrink-0">
              <button
                onClick={() => setActiveTab('chat')}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'chat' ? 'border-gold-500 text-gold-500' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
              >
                <MessageSquare size={14} /> Chat Evidence
              </button>
              <button
                onClick={() => setActiveTab('resolve')}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'resolve' ? 'border-gold-500 text-gold-500' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
              >
                <Scale size={14} /> Resolve
              </button>
            </div>

            {}
            {activeTab === 'chat' && (
              <div className="flex flex-col flex-1 min-h-0">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-1 pb-2">
                  {chatLoading ? (
                    <div className="flex items-center justify-center h-32 text-gray-400">
                      <Clock className="h-5 w-5 animate-spin mr-2" /> Loading chat…
                    </div>
                  ) : chatMsgs.length === 0 ? (
                    <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
                      No messages in this order chat yet.
                    </div>
                  ) : (
                    <>
                      {chatMsgs.map(renderBubble)}
                      <div ref={chatBottomRef} />
                    </>
                  )}
                </div>
                {/* Admin reply box */}
                {selected.status === 'DISPUTED' && (
                  <div className="flex-shrink-0 border-t border-dark-600 pt-3 mt-2">
                    <p className="text-xs text-gray-500 mb-1">Post admin mediation message (visible to both parties):</p>
                    <div className="flex gap-2">
                      <textarea
                        value={adminMsg}
                        onChange={e => setAdminMsg(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendAdminMsg(); } }}
                        placeholder="Type mediator message… Enter to send"
                        rows={2}
                        className="flex-1 input text-sm resize-none"
                        disabled={sendingMsg}
                      />
                      <button onClick={handleSendAdminMsg} disabled={!adminMsg.trim() || sendingMsg}
                        className="px-3 py-2 bg-gold-500 text-black rounded-lg hover:bg-gold-400 disabled:opacity-50 flex-shrink-0">
                        {sendingMsg ? <Clock className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">Message will be tagged [Admin] and sent to user + merchant in real time.</p>
                  </div>
                )}
              </div>
            )}

            {/* Resolve tab */}
            {activeTab === 'resolve' && (
              <div className="space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="label">Decision</label>
                  <select value={decision} onChange={e => setDecision(e.target.value)} className="input">
                    <option value="FAVOR_USER">✓ APPROVE — Refund user, penalise merchant</option>
                    <option value="FAVOR_MERCHANT">✗ REJECT — No refund, favour merchant</option>
                    <option value="SPLIT">↔ SPLIT — Partial refund</option>
                  </select>
                </div>

                {(decision === 'RELEASE_TO_USER' || decision === 'SPLIT') && (
                  <div>
                    <label className="label">
                      Refund Amount (₹) {decision === 'RELEASE_TO_USER' ? '— blank = full amount' : ''}
                    </label>
                    <input type="number" value={refundAmt} onChange={e => setRefundAmt(e.target.value)}
                      className="input" placeholder={decision === 'RELEASE_TO_USER' ? 'Full amount by default' : 'Enter split amount'} />
                  </div>
                )}

                {decision === 'RELEASE_TO_MERCHANT' && (
                  <div>
                    <label className="label">Merchant Penalty (₹) — optional</label>
                    <input type="number" value={penaltyAmt} onChange={e => setPenaltyAmt(e.target.value)}
                      className="input" placeholder="0" />
                  </div>
                )}

                <div>
                  <label className="label">Resolution Notes *</label>
                  <textarea value={resolution} onChange={e => setResolution(e.target.value)}
                    className="input min-h-[80px] resize-none"
                    placeholder="Explain the decision… This is posted as a system message in the chat." />
                </div>

                <div className="flex gap-3">
                  <button onClick={() => setSelected(null)} className="flex-1 btn-secondary">Cancel</button>
                  <button onClick={handleResolve} disabled={isSaving || !resolution.trim()}
                    className="flex-1 btn-primary disabled:opacity-50">
                    {isSaving ? 'Processing…'
                      : decision === 'RELEASE_TO_USER'     ? '✓ Approve — Refund User'
                      : decision === 'RELEASE_TO_MERCHANT'  ? '✗ Reject — No Refund'
                      : '↔ Apply Split'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


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
/** One dispute as the server's one mapper sends it (`toDisputeView`,
 *  backend/domains/disputes/disputeResolution.admin.routes.js), for the cards
 *  and for the dialog alike. The parties are `{ userId, username }` and
 *  `{ merchantId, name }`: this type said `merchantId.username`, which is never
 *  sent, so the card's "Merchant:" line was always blank (§23). */
interface Dispute {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  fiatAmount: number;
  status: string;
  createdAt: string;
  userId?: { userId: string; username: string; mobile?: string } | null;
  merchantId?: { merchantId: string; name: string; mobile?: string } | null;
  disputeReason?: string;
  disputeResolution?: string | null;
  disputeDecision?: string | null;
  disputeEscalated?: boolean;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  utrNumber?: string;
  proofScreenshot?: string;
  /** Who each decision suspends, from the server's one rule
   *  (backend/domains/disputes/disputeOutcome.service.js): 'PLAYER', 'MERCHANT'
   *  (the team member), or null when it is not a dispute about a payment. */
  suspendsIfToUser?: 'PLAYER' | 'MERCHANT' | null;
  suspendsIfToMerchant?: 'PLAYER' | 'MERCHANT' | null;
}

/** The note under the decision: who the server will suspend if it is taken. */
function suspensionNote(party: 'PLAYER' | 'MERCHANT' | null | undefined): string {
  if (party === 'MERCHANT') return 'The team member on this order will be suspended. A sub-admin or admin must lift it; after a third lost dispute only an admin can.';
  if (party === 'PLAYER') return 'The player will be suspended. A sub-admin or admin must lift it; after a third lost dispute only an admin can.';
  return 'Nobody is suspended by this decision: it is not a dispute over whether a payment was made (a member\'s red flag, or a buy disputed after it completed).';
}

interface ChatMsg {
  id: string;
  // SUPERVISOR: the member's supervisor speaking for them (Step 2f).
  senderType: 'USER' | 'MERCHANT' | 'ADMIN' | 'SYSTEM' | 'SUPERVISOR';
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
  const [isSaving, setIsSaving]           = useState(false);

  // ── The filters are the SERVER's (`DISPUTE_FILTERS`, orders.record.js) ────
  // This screen kept its own four ("all", "DISPUTED", "RESOLVED", "ESCALATED"),
  // which the queue read as order states: it opened on state 'all' and listed
  // nothing, and two of the four asked for states no order can be in. Now it
  // asks with no filter on arrival, shows the one the server applied, and
  // offers exactly the list the server sends back (§5, §32 S25).
  const [filter, setFilter]               = useState<string | null>(null);
  const [applied, setApplied]             = useState<string>('');
  const [filters, setFilters]             = useState<{ key: string; label: string }[]>([]);
  // The server pages the queue; the screen shows where it is in it rather than
  // silently showing the first page as if it were all of it (§32 S47).
  const [page, setPage]                   = useState(1);
  const [pages, setPages]                 = useState(1);
  const [total, setTotal]                 = useState(0);
  const [perPage, setPerPage]             = useState(0);

  // ── Load disputes list ────────────────────────────────────────────────────
  const load = async () => {
    setIsLoading(true);
    try {
      const res = await api.get<any>('/api/admin/dispute-orders', {
        params: { page, ...(filter ? { filter } : {}) },
      });
      const body = res.data ?? {};
      setDisputes(body.disputes || []);
      setFilters(Array.isArray(body.filters) ? body.filters : []);
      setApplied(typeof body.filter === 'string' ? body.filter : '');
      setTotal(Number(body.total) || 0);
      setPages(Math.max(Number(body.pages) || 1, 1));
      setPerPage(Number(body.limit) || 0);
      // A page that emptied under us (the last dispute on it was decided):
      // step back to the last page that has any.
      if ((body.disputes || []).length === 0 && Number(body.total) > 0 && page > Number(body.pages)) {
        setPage(Math.max(Number(body.pages) || 1, 1));
      }
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to load disputes'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { load(); }, [filter, page]);

  const chooseFilter = (key: string) => { setFilter(key); setPage(1); };
  const appliedLabel = filters.find((f) => f.key === applied)?.label;
  const firstShown = total === 0 ? 0 : (page - 1) * perPage + 1;
  const lastShown = Math.min(total, (page - 1) * perPage + disputes.length);

  
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
    // A supervisor speaks on the member's side of the dispute.
    const isMerchant = msg.senderType === 'MERCHANT' || msg.senderType === 'SUPERVISOR';
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
            {text && <p className="whitespace-pre-wrap wrap-break-word">{text}</p>}
            {msg.attachmentUrl && (
              <div className="mt-2">
                <img
                  src={msg.attachmentUrl} alt="Attachment"
                  className="rounded-sm max-w-full cursor-pointer hover:opacity-90"
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
          {filters.length > 0 && (
            <select aria-label="Filter disputes by status" value={applied} onChange={e => chooseFilter(e.target.value)} className="input text-sm">
              {filters.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          )}
          <button onClick={load} title="Reload the dispute queue" aria-label="Reload the dispute queue"
            className="p-2 hover:bg-dark-700 rounded-lg"><RefreshCw size={16} /></button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading disputes…</div>
      ) : disputes.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <CheckCircle size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-lg">{appliedLabel ? `No disputes under "${appliedLabel}"` : 'No disputes found'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p role="status" className="text-sm text-gray-400">
            Showing {firstShown}–{lastShown} of {total} {total === 1 ? 'dispute' : 'disputes'}
            {appliedLabel ? ` · ${appliedLabel}` : ''}{pages > 1 ? ` · page ${page} of ${pages}` : ''}
          </p>
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
                  <p className="text-sm"><span className="text-gray-400">Merchant: </span>{d.merchantId?.name}</p>
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
                  {/* The decision, whenever there is one. This asked for
                      status 'RESOLVED', which no order is ever in (a decided
                      dispute is COMPLETED or CANCELLED), so no decision was
                      ever shown. */}
                  {d.disputeDecision && (
                    <p className="text-xs text-green-400">
                      Decision: {d.disputeDecision.replace(/_/g, ' ')}
                      {d.resolvedAt ? ` · ${fmtDate(d.resolvedAt)}` : ''}
                    </p>
                  )}
                  {d.status === 'DISPUTED' && d.disputeEscalated && (
                    <p className="text-xs text-amber-300">Escalated</p>
                  )}
                </div>
              </div>
            </div>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1}
                aria-label="Previous page of disputes"
                className="px-3 py-1.5 bg-dark-700 text-gray-300 text-xs font-semibold rounded-lg disabled:opacity-40">
                Previous
              </button>
              <button onClick={() => setPage((p) => Math.min(p + 1, pages))} disabled={page >= pages}
                aria-label="Next page of disputes"
                className="px-3 py-1.5 bg-dark-700 text-gray-300 text-xs font-semibold rounded-lg disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Dispute Modal ─────────────────────────────────────────────────── */}
      {selected && (
        <Modal isOpen onClose={() => setSelected(null)} title={`Dispute — ${selected.orderId}`}>
          <div className="flex flex-col" style={{ height: '70vh' }}>
            {/* Order summary */}
            <div className="bg-dark-700 rounded-lg p-3 text-sm space-y-1 mb-3 shrink-0">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="flex justify-between"><span className="text-gray-400">Amount</span><span className="font-bold">{formatters.currency(selected.fiatAmount || selected.amount)}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Type</span><span>{selected.type}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">User</span><span>{selected.userId?.username} ({selected.userId?.mobile})</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Merchant</span><span>{selected.merchantId?.name}</span></div>
              </div>
              {selected.disputeReason && (
                <div className="mt-1 text-yellow-400 text-xs">⚠ Reason: {selected.disputeReason}</div>
              )}
              {selected.utrNumber && (
                <div className="text-xs"><span className="text-gray-400">UTR: </span><span className="font-mono text-green-400">{selected.utrNumber}</span></div>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-dark-600 mb-3 shrink-0">
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
                  <div className="shrink-0 border-t border-dark-600 pt-3 mt-2">
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
                        className="px-3 py-2 bg-gold-500 text-black rounded-lg hover:bg-gold-400 disabled:opacity-50 shrink-0">
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
                {/* The values are the three the resolve route accepts
                    (disputeResolution.admin.routes.js). The options used to be
                    FAVOR_USER / FAVOR_MERCHANT / SPLIT, which the route refuses
                    as "Invalid decision", so only the untouched default could
                    ever be sent: no dispute could be decided for the team. */}
                <div>
                  <label className="label" htmlFor="decision">Decision</label>
                  <select id="decision" value={decision} onChange={e => setDecision(e.target.value)} className="input">
                    {selected.type === 'DEPOSIT' ? (<>
                      <option value="RELEASE_TO_USER">The player paid: credit the player's tokens</option>
                      <option value="RELEASE_TO_MERCHANT">The player did not pay: tokens go back to the team pool</option>
                    </>) : (<>
                      <option value="RELEASE_TO_MERCHANT">The member paid: the player's tokens go to the team pool</option>
                      <option value="RELEASE_TO_USER">The member did not pay: return the tokens to the player</option>
                    </>)}
                  </select>
                </div>

                {/* Whoever the decision goes against is suspended by the server
                    (disputeOutcome.service.js), so the admin is told before
                    pressing, not after. */}
                <p role="note" className="text-xs text-amber-300 bg-amber-900/20 border border-amber-700/40 rounded-lg p-2">
                  {suspensionNote(decision === 'RELEASE_TO_USER' ? selected.suspendsIfToUser : selected.suspendsIfToMerchant)}
                </p>

                <div>
                  <label className="label" htmlFor="resolution-notes">Resolution Notes *</label>
                  <textarea id="resolution-notes" value={resolution} onChange={e => setResolution(e.target.value)}
                    className="input min-h-[80px] resize-none"
                    placeholder="Explain the decision… This is posted as a system message in the chat." />
                </div>

                <div className="flex gap-3">
                  <button onClick={() => setSelected(null)} className="flex-1 btn-secondary">Cancel</button>
                  <button onClick={handleResolve} disabled={isSaving || !resolution.trim()}
                    className="flex-1 btn-primary disabled:opacity-50">
                    {isSaving ? 'Processing…' : 'Decide dispute'}
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

// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Chat & Support console — Command Center design (handoff "Betting Bazaar
// Admin.dc.html"). Two-panel moderation + support desk over the public-chat and
// support-ticket collections, wired to the admin chat routes
// (routes/admin/chat.admin.routes.js). Renders honest empty states when the
// collections have no data yet.
import React, { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Ban, Trash2, Send, Hash } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import api from '../../services/api';
import toast from 'react-hot-toast';

const AV = [
  'linear-gradient(140deg,#3d6bd6,#7b4fe0)', 'linear-gradient(140deg,#e08a3d,#d4593a)',
  'linear-gradient(140deg,#34a97f,#2b8f6f)', 'linear-gradient(140deg,#b57cf0,#7b4fe0)',
  'linear-gradient(140deg,#d4913a,#b8941f)',
];
const initials = (name?: string) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
const time = (d?: string) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '');

type Selection = { type: 'public' } | { type: 'ticket'; id: string };

export const ChatSupport: React.FC = () => {
  const [tickets, setTickets] = useState<any[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [publicMsgs, setPublicMsgs] = useState<any[]>([]);
  const [bans, setBans] = useState<any[]>([]);
  const [selection, setSelection] = useState<Selection>({ type: 'public' });
  const [ticketDetail, setTicketDetail] = useState<{ ticket: any; messages: any[] } | null>(null);
  const [reply, setReply] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [banTarget, setBanTarget] = useState<{ userId: string; name: string } | null>(null);
  const [banReason, setBanReason] = useState('');

  const loadAll = async () => {
    try {
      const [t, m, b] = await Promise.allSettled([api.chat.getTickets(), api.chat.getMessages(60), api.chat.getBans()]);
      if (t.status === 'fulfilled' && (t.value as any)?.success) { setTickets((t.value as any).tickets || []); setOpenCount((t.value as any).openCount || 0); }
      if (m.status === 'fulfilled' && (m.value as any)?.success) setPublicMsgs((m.value as any).messages || []);
      if (b.status === 'fulfilled' && (b.value as any)?.success) setBans((b.value as any).bans || []);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (selection.type !== 'ticket') { setTicketDetail(null); return; }
    let alive = true;
    api.chat.getTicket(selection.id).then((r: any) => { if (alive && r?.success) setTicketDetail({ ticket: r.ticket, messages: r.messages || [] }); }).catch(() => {});
    return () => { alive = false; };
  }, [selection]);

  const deleteMessage = async (id: string) => {
    try { await api.chat.deleteMessage(id); setPublicMsgs((p) => p.filter((m) => m._id !== id)); toast.success('Message deleted'); }
    catch (e: any) { toast.error(e.response?.data?.message || 'Failed to delete message'); }
  };

  const doBan = async () => {
    if (!banTarget) return;
    if (!banReason.trim()) { toast.error('A ban reason is required'); return; }
    try {
      await api.chat.banUser(banTarget.userId, banReason.trim(), 24);
      toast.success('User banned from chat for 24h');
      setBanTarget(null); setBanReason('');
      loadAll();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to ban user'); }
  };

  const sendReply = async () => {
    if (selection.type !== 'ticket' || !reply.trim()) return;
    const id = selection.id;
    try {
      await api.chat.reply(id, reply.trim());
      setReply('');
      const r: any = await api.chat.getTicket(id);
      if (r?.success) setTicketDetail({ ticket: r.ticket, messages: r.messages || [] });
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to send reply'); }
  };

  const stats = useMemo(() => ([
    { label: 'Open Tickets', value: String(openCount), color: 'var(--warning)' },
    { label: 'Public Messages', value: String(publicMsgs.length), color: 'var(--text)' },
    { label: 'Active Bans', value: String(bans.length), color: 'var(--danger)' },
  ]), [openCount, publicMsgs.length, bans.length]);

  if (isLoading) return <LoadingSpinner size="lg" />;

  const activeTicket = selection.type === 'ticket' ? tickets.find((t) => t._id === selection.id) : null;
  const activeName = activeTicket?.userId?.username || 'Public Chat';

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        {stats.map((k) => (
          <div key={k.label} className="card" style={{ padding: '15px 16px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{k.label}</div>
            <div className="font-mono" style={{ fontSize: 22, fontWeight: 800, marginTop: 7, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Conversation list */}
        <div className="card" style={{ padding: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.08em', textTransform: 'uppercase', padding: '9px 9px 7px' }}>Conversations</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Public room */}
            <div onClick={() => setSelection({ type: 'public' })} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 12px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${selection.type === 'public' ? 'var(--gold)' : 'transparent'}`, background: selection.type === 'public' ? 'var(--active)' : 'transparent' }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#fff', background: 'linear-gradient(140deg,#d4913a,#b8941f)' }}><Hash size={16} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Public Chat</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{publicMsgs.length} recent messages</div>
              </div>
            </div>
            {/* Tickets */}
            {tickets.map((t, i) => {
              const active = selection.type === 'ticket' && selection.id === t._id;
              return (
                <div key={t._id} onClick={() => setSelection({ type: 'ticket', id: t._id })} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 12px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${active ? 'var(--gold)' : 'transparent'}`, background: active ? 'var(--active)' : 'transparent' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, color: '#fff', background: AV[i % 5] }}>{initials(t.userId?.username)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.userId?.username || 'User'}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</div>
                  </div>
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '2px 7px', borderRadius: 20 }}>{t.status}</span>
                </div>
              );
            })}
            {tickets.length === 0 && (
              <div style={{ padding: '18px 12px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>No support tickets yet</div>
            )}
          </div>
        </div>

        {/* Message panel */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 560 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, color: '#fff', background: selection.type === 'public' ? 'linear-gradient(140deg,#d4913a,#b8941f)' : AV[0] }}>
              {selection.type === 'public' ? <Hash size={18} /> : initials(activeName)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>{selection.type === 'public' ? 'Public Chat' : activeName}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{selection.type === 'public' ? 'Live room · moderation' : activeTicket?.subject || 'Support ticket'}</div>
            </div>
            {selection.type === 'ticket' && activeTicket?.userId?._id && (
              <button onClick={() => setBanTarget({ userId: activeTicket.userId._id, name: activeName })} style={{ height: 34, padding: '0 13px', borderRadius: 8, background: 'var(--danger-bg)', border: '1px solid var(--danger)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', color: 'var(--danger)' }}>
                <Ban size={14} /> Ban
              </button>
            )}
          </div>

          {/* Body */}
          {selection.type === 'public' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {publicMsgs.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted)' }}>
                  <MessageCircle size={30} /><div style={{ fontSize: 13 }}>No public chat messages</div>
                </div>
              ) : publicMsgs.map((m, i) => (
                <div key={m._id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 11, color: '#fff', background: AV[i % 5] }}>{initials(m.displayName)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}><span style={{ fontWeight: 700 }}>{m.displayName}</span> <span style={{ color: 'var(--text-2)' }}>{m.type === 'image' ? '[image]' : m.content}</span></div>
                    <div className="font-mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{time(m.createdAt)}</div>
                  </div>
                  <button title="Delete" onClick={() => deleteMessage(m._id)} style={{ width: 30, height: 30, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-2)' }}><Trash2 size={14} /></button>
                  {m.userId && <button title="Ban user" onClick={() => setBanTarget({ userId: String(m.userId), name: m.displayName })} style={{ width: 30, height: 30, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--danger)' }}><Ban size={14} /></button>}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {ticketDetail?.messages?.length ? ticketDetail.messages.map((m) => {
                  const me = m.senderType === 'agent';
                  return (
                    <div key={m._id} style={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start' }}>
                      <div style={{ maxWidth: '76%' }}>
                        <div style={{ padding: '9px 13px', borderRadius: 13, fontSize: 13, lineHeight: 1.45, ...(me ? { background: 'var(--gold)', color: 'var(--gold-on)', borderBottomRightRadius: 4 } : { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderBottomLeftRadius: 4 }) }}>{m.content}</div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, textAlign: me ? 'right' : 'left' }}>{time(m.createdAt)}</div>
                      </div>
                    </div>
                  );
                }) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted)' }}>
                    <MessageCircle size={30} /><div style={{ fontSize: 13 }}>No messages in this ticket</div>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
                <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); }} placeholder="Type a reply…" style={{ flex: 1, height: 40, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 14px', fontSize: 13, outline: 'none' }} />
                <button onClick={sendReply} style={{ height: 40, padding: '0 18px', borderRadius: 10, background: 'var(--gold)', color: 'var(--gold-on)', display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none' }}>Send <Send size={15} /></button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Ban modal */}
      {banTarget && (
        <Modal isOpen={!!banTarget} onClose={() => { setBanTarget(null); setBanReason(''); }} title={`Ban ${banTarget.name} from chat`}>
          <div className="space-y-4">
            <p className="text-gray-400">Bans this user from public chat for 24 hours. Recorded in Audit Logs.</p>
            <div>
              <label className="label">Reason *</label>
              <textarea value={banReason} onChange={(e) => setBanReason(e.target.value)} className="input min-h-[90px]" placeholder="Reason for the ban…" required />
            </div>
            <div className="flex space-x-3">
              <button onClick={() => { setBanTarget(null); setBanReason(''); }} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={doBan} className="flex-1 btn-danger">Ban user</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ChatSupport;

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Public chat moderation — Command Center design (handoff "Betting Bazaar
// Admin.dc.html"), wired to the admin chat routes
// (routes/admin/chat.admin.routes.js). Support tickets are on the Support Desk
// screen (Pages/Support/SupportDesk.tsx; owner, 2026-10-21).
import React, { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Ban, Trash2, Hash } from 'lucide-react';
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

export const ChatSupport: React.FC = () => {
  const [publicMsgs, setPublicMsgs] = useState<any[]>([]);
  const [bans, setBans] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [banTarget, setBanTarget] = useState<{ userId: string; name: string } | null>(null);
  const [banReason, setBanReason] = useState('');

  const loadAll = async () => {
    try {
      const [m, b] = await Promise.allSettled([api.chat.getMessages(60), api.chat.getBans()]);
      if (m.status === 'fulfilled' && (m.value as any)?.success) setPublicMsgs((m.value as any).messages || []);
      if (b.status === 'fulfilled' && (b.value as any)?.success) setBans((b.value as any).bans || []);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

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

  // Lifting a ban. The route, the client method and the ban list all existed;
  // nothing on this screen listed the bans or called unban, so a moderator who
  // banned the wrong person could not undo it (measured: report:routes,
  // "client methods no screen calls").
  const liftBan = async (userId: string) => {
    try {
      await api.chat.unbanUser(userId);
      toast.success('Chat ban lifted');
      loadAll();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to lift the ban'); }
  };

  const stats = useMemo(() => ([
    { label: 'Public Messages', value: String(publicMsgs.length), color: 'var(--text)' },
    { label: 'Active Bans', value: String(bans.length), color: 'var(--danger)' },
  ]), [publicMsgs.length, bans.length]);

  if (isLoading) return <LoadingSpinner size="lg" />;

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

      <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: 'linear-gradient(140deg,#d4913a,#b8941f)' }}><Hash size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>Public Chat</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Live room · moderation</div>
          </div>
        </div>
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
      </div>

      {/* Active chat bans — who, why, until when, and the way to lift one */}
      <div className="card" style={{ marginTop: 16, padding: '16px 18px' }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>Chat bans</div>
        {bans.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nobody is banned from public chat.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {bans.map((b) => (
              <li key={b.userId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{b.userId}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                    {b.reason} · {b.banUntil ? `until ${new Date(b.banUntil).toLocaleString('en-IN')}` : 'permanent'}
                  </div>
                </div>
                <button onClick={() => liftBan(String(b.userId))} className="btn-secondary" style={{ height: 34 }}>
                  Lift ban
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Ban modal */}
      {banTarget && (
        <Modal isOpen={!!banTarget} onClose={() => { setBanTarget(null); setBanReason(''); }} title={`Ban ${banTarget.name} from chat`}>
          <div className="space-y-4">
            <p className="text-gray-400">Bans this user from public chat for 24 hours. Recorded in Audit Logs.</p>
            <div>
              <label className="label" htmlFor="reason">Reason *</label>
              <textarea id="reason" value={banReason} onChange={(e) => setBanReason(e.target.value)} className="input min-h-[90px]" placeholder="Reason for the ban…" required />
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

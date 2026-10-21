// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Support Desk — the player and merchant support desks, and the Telegram
 * accounts their tickets are given (CLAUDE.md §2, "Support desks"; owner,
 * 2026-10-21).
 *
 * A ticket is the form the account filled in; the conversation happens on
 * Telegram between the account and the support account the ticket names. The
 * desk is where an agent finds the ticket by its code or the sender's
 * @username, confirms who it is, writes the note the account reads in the app,
 * and closes it.
 *
 * Least privilege: the verified mobile is MASKED. "Show verified number" asks
 * the server, which writes who looked before it answers; the screen keeps the
 * number only until the ticket is closed in the view.
 *
 * Each tab is shown only with its permission: Player desk
 * (`canManageSupportTickets`), Merchant desk (`canManageMerchantSupport`),
 * Telegram accounts (`canManageTelegram`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Eye, LifeBuoy, Search, Send, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import type { SupportDeskKey } from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { LoadingSpinner } from '../../components/LoadingSpinner';

type Tab = SupportDeskKey | 'ACCOUNTS';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'var(--warning)' },
  ASSIGNED: { label: 'Assigned', color: 'var(--info, var(--gold))' },
  WAITING_USER: { label: 'Waiting on them', color: 'var(--warning)' },
  RESOLVED: { label: 'Resolved', color: 'var(--success)' },
  CLOSED: { label: 'Closed', color: 'var(--muted)' },
};
const DESK_NAME: Record<string, string> = { PLAYER: 'Player support', MERCHANT: 'Merchant support', DISPUTE: 'Dispute Managers' };
const when = (d?: string) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const errText = (e: any, fallback: string) => e?.response?.data?.message || fallback;

const pill = (status: string) => {
  const s = STATUS_LABEL[status] || { label: status, color: 'var(--muted)' };
  return <span style={{ fontSize: 10.5, fontWeight: 800, color: s.color, border: `1px solid ${s.color}`, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>{s.label}</span>;
};

const TicketDetail: React.FC<{ desk: SupportDeskKey; ticketId: string; onChanged: () => void }> = ({ desk, ticketId, onChanged }) => {
  const [data, setData] = useState<any>(null);
  const [number, setNumber] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.supportDesk.get(desk, ticketId); setData(r); }
    catch (e: any) { toast.error(errText(e, 'Could not load the ticket')); }
  }, [desk, ticketId]);
  useEffect(() => { setNumber(''); setNote(''); load(); }, [load]);

  const reveal = async () => {
    try {
      const r = await api.supportDesk.revealNumber(desk, ticketId);
      setNumber(r.mobile || 'No number on this account');
      load();
    } catch (e: any) { toast.error(errText(e, 'Could not show the number')); }
  };
  const addNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try { await api.supportDesk.addNote(desk, ticketId, note.trim()); setNote(''); await load(); onChanged(); }
    catch (e: any) { toast.error(errText(e, 'Could not save the note')); }
    finally { setBusy(false); }
  };
  const setStatus = async (status: string) => {
    setBusy(true);
    try { await api.supportDesk.setStatus(desk, ticketId, status); await load(); onChanged(); toast.success('Ticket updated'); }
    catch (e: any) { toast.error(errText(e, 'Could not update the ticket')); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="card" style={{ padding: 30 }}><LoadingSpinner /></div>;
  const { ticket, messages, reveals } = data;
  const acct = ticket.account || {};

  return (
    <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="font-mono" style={{ fontSize: 18, fontWeight: 800 }}>{ticket.code}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{ticket.topic} · opened {when(ticket.createdAt)}{ticket.telegramUsername ? ` · chat on @${ticket.telegramUsername}` : ' · no support account was free'}</div>
        </div>
        {pill(ticket.status)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14, padding: 18 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>Who sent it</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 12.5 }}>
            <span style={{ color: 'var(--muted)' }}>Account</span><span style={{ fontWeight: 700 }}>{acct.username || '—'}</span>
            <span style={{ color: 'var(--muted)' }}>Telegram</span>
            <span style={{ fontWeight: 700 }}>
              {acct.telegramUsername
                ? <a href={`https://t.me/${acct.telegramUsername}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)' }}>@{acct.telegramUsername}</a>
                : <span style={{ color: 'var(--muted)' }}>no username{acct.firstName ? ` · ${acct.firstName}` : ''}</span>}
            </span>
            <span style={{ color: 'var(--muted)' }}>Telegram ID</span><span className="font-mono">{acct.telegramId || '—'}</span>
            <span style={{ color: 'var(--muted)' }}>Mobile</span>
            <span className="font-mono" style={{ fontWeight: 700 }}>{number || acct.mobileMasked || '—'}</span>
          </div>
          {acct.telegramVerifiedAt && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--success)', marginTop: 9, fontWeight: 700 }}>
              <ShieldCheck size={14} /> Number verified by Telegram on {when(acct.telegramVerifiedAt)}
            </div>
          )}
          {!number && (
            <button onClick={reveal} className="btn-secondary" style={{ marginTop: 10, height: 34, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Eye size={14} /> Show verified number
            </button>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
            Each look is logged{reveals?.length ? ` · looked at ${reveals.length} time${reveals.length === 1 ? '' : 's'}, last ${when(reveals[0].revealedAt)}` : ''}.
          </div>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>The problem</div>
          {ticket.reference && <div style={{ fontSize: 12, marginBottom: 6 }}>Reference: <span className="font-mono" style={{ fontWeight: 700 }}>{ticket.reference}</span></div>}
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{messages.find((m: any) => m.senderType === 'USER')?.content || ticket.subject}</div>
          {ticket.rating && <div style={{ fontSize: 12, color: 'var(--gold)', marginTop: 8 }}>Rated {'★'.repeat(ticket.rating)}</div>}
        </div>
      </div>

      <div style={{ padding: '0 18px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.08em', textTransform: 'uppercase' }}>Notes the account sees in the app</div>
        {messages.filter((m: any) => m.senderType === 'AGENT').map((m: any) => (
          <div key={m.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 12px' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>{when(m.createdAt)}</div>
            <div style={{ fontSize: 13, lineHeight: 1.45 }}>{m.content}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border)', marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} placeholder="A short note: what was found, what was done" style={{ flex: 1, height: 40, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 14px', fontSize: 13, outline: 'none' }} />
          <button onClick={addNote} disabled={busy || !note.trim()} style={{ height: 40, padding: '0 16px', borderRadius: 10, background: 'var(--gold)', color: 'var(--gold-on)', display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', opacity: busy || !note.trim() ? .6 : 1 }}>Add note <Send size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={() => setStatus('WAITING_USER')} className="btn-secondary" style={{ height: 34 }}>Waiting on them</button>
          <button disabled={busy} onClick={() => setStatus('RESOLVED')} className="btn-secondary" style={{ height: 34, color: 'var(--success)' }}>Resolved</button>
          <button disabled={busy} onClick={() => setStatus('CLOSED')} className="btn-secondary" style={{ height: 34 }}>Close</button>
        </div>
      </div>
    </div>
  );
};

const DeskView: React.FC<{ desk: SupportDeskKey }> = ({ desk }) => {
  const [view, setView] = useState<'current' | 'older'>('current');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<{ tickets: any[]; openCount: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.supportDesk.list(desk, { older: view === 'older', q: search })); }
    catch (e: any) { toast.error(errText(e, 'Could not load the desk')); setData({ tickets: [], openCount: 0 }); }
  }, [desk, view, search]);
  useEffect(() => { setSelected(null); load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="card" style={{ padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>Live tickets</div>
          <div className="font-mono" style={{ fontSize: 20, fontWeight: 800, color: 'var(--warning)' }}>{data?.openCount ?? '…'}</div>
        </div>
        {(['current', 'older'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className="btn-secondary" style={{ height: 36, borderColor: view === v ? 'var(--gold)' : undefined, color: view === v ? 'var(--gold)' : undefined }}>
            {v === 'current' ? 'Live + last 7 days' : 'Older closed'}
          </button>
        ))}
        <div style={{ flex: 1, minWidth: 220, display: 'flex', gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSearch(q.trim()); }} placeholder="Ticket code (S-…) or @username" style={{ flex: 1, height: 36, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', color: 'var(--text)', padding: '0 12px', fontSize: 13, outline: 'none' }} />
          <button onClick={() => setSearch(q.trim())} className="btn-secondary" style={{ height: 36 }} aria-label="Search"><Search size={15} /></button>
        </div>
      </div>

      <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,340px) 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 640, overflowY: 'auto' }}>
          {!data && <LoadingSpinner />}
          {data?.tickets.length === 0 && <div style={{ padding: 18, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>No tickets here</div>}
          {data?.tickets.map((t) => {
            const active = selected === t.ticketId;
            return (
              <button key={t.ticketId} type="button" onClick={() => setSelected(t.ticketId)} aria-pressed={active}
                style={{ display: 'block', textAlign: 'left', padding: '11px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${active ? 'var(--gold)' : 'transparent'}`, background: active ? 'var(--active)' : 'transparent', width: '100%', font: 'inherit', color: 'inherit' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <span className="font-mono" style={{ fontWeight: 800, fontSize: 13 }}>{t.code}</span>
                  {pill(t.status)}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {t.account?.telegramUsername ? `@${t.account.telegramUsername}` : t.account?.username || 'account'} · {t.topic} · {when(t.createdAt)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</div>
              </button>
            );
          })}
        </div>
        {selected
          ? <TicketDetail desk={desk} ticketId={selected} onChanged={load} />
          : <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><LifeBuoy size={30} /><div style={{ marginTop: 8, fontSize: 13 }}>Pick a ticket. When a chat arrives on Telegram, search its code here.</div></div>}
      </div>
    </div>
  );
};

const AccountsView: React.FC = () => {
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [form, setForm] = useState({ desk: 'PLAYER', telegramUsername: '', label: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setContacts((await api.supportDesk.contacts()).contacts || []); }
    catch (e: any) { toast.error(errText(e, 'Could not load the accounts')); setContacts([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true);
    try { await api.supportDesk.addContact(form); setForm({ ...form, telegramUsername: '', label: '' }); toast.success('Account added'); load(); }
    catch (e: any) { toast.error(errText(e, 'Could not add the account')); }
    finally { setBusy(false); }
  };
  const toggle = async (c: any) => {
    try { await api.supportDesk.updateContact(c.contactId, { telegramUsername: c.telegramUsername, label: c.label, active: !c.active }); load(); }
    catch (e: any) { toast.error(errText(e, 'Could not change the account')); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>Add a Telegram account</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 12px', lineHeight: 1.5 }}>
          Use an account the business owns (its own SIM, two-step verification on), not an agent&apos;s personal one. New tickets go to the desk&apos;s active account with the fewest live tickets. Dispute Manager accounts are shown only on a disputed order.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select value={form.desk} onChange={(e) => setForm({ ...form, desk: e.target.value })} className="input" style={{ height: 38, width: 190 }}>
            {Object.entries(DESK_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input value={form.telegramUsername} onChange={(e) => setForm({ ...form, telegramUsername: e.target.value })} placeholder="@bb_help_1" className="input" style={{ height: 38, flex: 1, minWidth: 160 }} />
          <input value={form.label} maxLength={60} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label (e.g. Day shift)" className="input" style={{ height: 38, flex: 1, minWidth: 160 }} />
          <button onClick={add} disabled={busy || !form.telegramUsername.trim()} className="btn-primary" style={{ height: 38 }}>Add</button>
        </div>
      </div>
      {!contacts ? <LoadingSpinner /> : Object.keys(DESK_NAME).map((desk) => (
        <div key={desk} className="card" style={{ padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>{DESK_NAME[desk]}</div>
          {contacts.filter((c) => c.desk === desk).length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--warning)' }}>No account yet. {desk === 'DISPUTE' ? 'Disputed orders show no Telegram button.' : 'Tickets open, but nobody can be chatted with on Telegram.'}</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'left' }}><th style={{ padding: '6px 8px' }}>Telegram</th><th style={{ padding: '6px 8px' }}>Label</th><th style={{ padding: '6px 8px' }}>Live tickets</th><th style={{ padding: '6px 8px' }}>State</th><th /></tr></thead>
                <tbody>
                  {contacts.filter((c) => c.desk === desk).map((c) => (
                    <tr key={c.contactId} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '9px 8px' }}><a href={`https://t.me/${c.telegramUsername}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)', fontWeight: 700 }}>@{c.telegramUsername}</a></td>
                      <td style={{ padding: '9px 8px', color: 'var(--text-2)' }}>{c.label || '—'}</td>
                      <td className="font-mono" style={{ padding: '9px 8px' }}>{c.openTickets}</td>
                      <td style={{ padding: '9px 8px', color: c.active ? 'var(--success)' : 'var(--muted)', fontWeight: 700 }}>{c.active ? 'Active' : 'Off'}</td>
                      <td style={{ padding: '9px 8px', textAlign: 'right' }}><button onClick={() => toggle(c)} className="btn-secondary" style={{ height: 32 }}>{c.active ? 'Switch off' : 'Switch on'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      ))}
    </div>
  );
};

export const SupportDesk: React.FC = () => {
  const { can, isAdmin } = usePermissions();
  const tabs: { key: Tab; label: string }[] = [
    ...(isAdmin || can('canManageSupportTickets') ? [{ key: 'PLAYER' as Tab, label: 'Player desk' }] : []),
    ...(isAdmin || can('canManageMerchantSupport') ? [{ key: 'MERCHANT' as Tab, label: 'Merchant desk' }] : []),
    ...(isAdmin || can('canManageTelegram') ? [{ key: 'ACCOUNTS' as Tab, label: 'Telegram accounts' }] : []),
  ];
  const [tab, setTab] = useState<Tab | null>(null);
  const current = tab && tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;

  if (!current) return <div className="card" style={{ padding: 30 }}>You have no support permission.</div>;
  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: `1px solid ${current === t.key ? 'var(--gold)' : 'var(--border)'}`, background: current === t.key ? 'var(--active)' : 'var(--surface)', color: current === t.key ? 'var(--gold)' : 'var(--text-2)' }}>{t.label}</button>
        ))}
      </div>
      {current === 'ACCOUNTS' ? <AccountsView /> : <DeskView key={current} desk={current} />}
    </div>
  );
};

export default SupportDesk;

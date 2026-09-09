// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * SupportPage.tsx — admin-configured support channels, and a chat that is real.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * The in-app panel was a prop. `send()` made NO network call: it appended a
 * canned "Thanks! An agent is looking into this and will reply here shortly."
 * to local state, under a hardcoded header reading "Agent online · avg reply
 * 2 min". A player with a money problem typed it out, was told help was on the
 * way, and nothing was sent anywhere. No ticket existed, so no agent could ever
 * answer.
 *
 * The admin side had a full ticket desk the whole time; there was simply no
 * player-facing route to put anything into it. Those routes exist now
 * (POST/GET /api/support/tickets and .../reply), and this panel uses them.
 *
 * Nothing here claims an agent is present. It reports what is true — the ticket
 * was created, and whether anyone has replied yet — because on a platform
 * holding somebody's money, an invented "avg reply 2 min" is a promise the
 * product cannot keep.
 *
 * ── The assistant, and the line it must not cross ───────────────────────────
 * POST /api/support/ask answers from the ingested knowledge base only, and is
 * built to refuse rather than guess. It is offered BEFORE a ticket is opened,
 * because most questions are policy questions an operator has already written
 * down, and a player who gets the answer in two seconds is better served than
 * one who waits for an agent.
 *
 * It never swallows the message. Three rules hold it there:
 *   1. Every assistant reply carries a visible route to a human, and the text
 *      the player typed is preserved so opening a ticket costs one tap.
 *   2. An ungrounded answer (`grounded: false` — nothing matched) is not shown
 *      as an answer at all. The ticket is the offer.
 *   3. Once a ticket exists the assistant stops intercepting entirely. The
 *      player has asked for a human; answering them with a robot again is the
 *      behaviour this file was written to delete.
 * If the assistant is dormant or its call fails, the composer opens a ticket
 * exactly as it did before — the human path never depends on it.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { getBackend } from '../services/backend.service';
import { apiUrl } from '../services/apiUrl';
import ScreenShell, { card } from '../redesign/Screen';

const backend = getBackend();

interface SupportLinks { whatsapp: string; telegram: string; telegramGroupUrl: string; telegramChannelUrl: string; instagram: string; youtube: string; email: string; }
interface ChatMsg { me: boolean; t: string; who?: string; assistant?: boolean; }

const authHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
};

const SupportChat: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [ticket, setTicket] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Set only when BOTH halves of the assistant are configured. `enabled` is the
  // server's own conjunction of retrievalReady && generationReady; asking with
  // either half missing is a guaranteed 503 and a wasted round trip for a
  // player who is already having a problem.
  const [assistantOn, setAssistantOn] = useState(false);
  // The question a failed/unhelpful assistant answer can still be escalated
  // with, so the player never retypes what they already wrote.
  const [escalate, setEscalate] = useState<string>('');
  const bottom = useRef<HTMLDivElement>(null);

  const render = (messages: any[]): ChatMsg[] =>
    messages.map((m) => ({ me: m.senderType === 'USER', t: m.content, who: m.senderType === 'USER' ? 'You' : 'Support' }));

  /** Load the newest open ticket so a returning player continues the thread. */
  const loadThread = async () => {
    try {
      const r = await fetch(apiUrl('/api/support/tickets'), { headers: authHeaders() });
      const d = await r.json();
      const open = (d?.tickets || []).find((t: any) => t.status !== 'CLOSED');
      if (!open) { setLoading(false); return; }
      const t = await fetch(apiUrl(`/api/support/tickets/${open.ticketId}`), { headers: authHeaders() });
      const td = await t.json();
      if (td?.success) { setTicket(td.ticket); setMsgs(render(td.messages || [])); }
    } catch { /* the panel still lets them open a new ticket */ }
    finally { setLoading(false); }
  };

  /**
   * Is the assistant worth asking? Unauthenticated on purpose (the route is),
   * and failure is silently "no" — a status probe must never stop a player
   * reaching a human.
   */
  const loadAssistant = async () => {
    try {
      const r = await fetch(apiUrl('/api/support/status'));
      const d = await r.json();
      setAssistantOn(Boolean(d?.success && d?.enabled));
    } catch { setAssistantOn(false); }
  };

  useEffect(() => { loadThread(); loadAssistant(); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length]);

  /**
   * Open a ticket with `t`, or reply to the one already open.
   * The optimistic line is assumed to be on screen already; on failure the
   * caller removes it and puts the text back in the box.
   */
  const openOrReply = async (t: string) => {
    if (!ticket) {
      const r = await fetch(apiUrl('/api/support/tickets'), {
        method: 'POST', headers: authHeaders(),
        // The subject is the first line of what they wrote, so an agent sees
        // the problem in the queue rather than a placeholder.
        body: JSON.stringify({ subject: t.slice(0, 120), message: t }),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.message || 'Could not open a ticket');
      setTicket(d.ticket);
    } else {
      const r = await fetch(apiUrl(`/api/support/tickets/${ticket.ticketId}/reply`), {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ content: t }),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.message || 'Could not send your message');
    }
  };

  /**
   * Escalate the question the assistant could not settle. Nothing is retyped
   * and nothing is lost — the same text becomes the ticket.
   */
  const escalateToHuman = async () => {
    const t = escalate;
    if (!t || busy) return;
    setBusy(true); setError('');
    setEscalate('');
    try {
      await openOrReply(t);
      setMsgs(prev => [...prev, { me: false, t: 'Sent to our support team. Their replies appear here.', who: 'Support' }]);
    } catch (e: any) {
      setError(e.message || 'Could not send. Try one of the channels below.');
      setEscalate(t); // still escalatable — the offer does not disappear on a failure
    } finally { setBusy(false); }
  };

  /**
   * Ask the assistant. Returns true when it produced a grounded answer, false
   * for anything else — dormant, ungrounded, rate-limited or a network failure
   * — so the caller falls through to a human every time it is not certain.
   */
  const askAssistant = async (t: string): Promise<boolean> => {
    try {
      const r = await fetch(apiUrl('/api/support/ask'), {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ query: t }),
      });
      const d = await r.json();
      // `grounded: false` means nothing in the knowledge base matched, and the
      // server returns a canned "contact support" line for it. Showing that as
      // an answer would be the fake reply this panel exists to have removed.
      if (!r.ok || !d?.success || !d?.grounded || !String(d?.answer || '').trim()) return false;
      setMsgs(prev => [...prev, { me: false, t: String(d.answer).trim(), who: 'Assistant', assistant: true }]);
      return true;
    } catch { return false; }
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setError('');
    // Shown immediately so typing feels responsive, then reconciled from the
    // server — never a fabricated reply alongside it.
    setMsgs(prev => [...prev, { me: true, t, who: 'You' }]);
    setText('');

    // Only before a ticket exists. Once the player has a human thread open,
    // every message goes to that thread.
    if (assistantOn && !ticket) {
      const answered = await askAssistant(t);
      // Either way the question stays escalatable in one tap: answered, in case
      // the answer missed; unanswered, because a human is now the only path.
      setEscalate(t);
      setBusy(false);
      if (answered) return;
      setMsgs(prev => [...prev, {
        me: false, who: 'Assistant', assistant: true,
        t: "I don't have an answer for that in our help centre. Send it to our support team below and a person will pick it up.",
      }]);
      return;
    }

    try {
      // One owner for the open-or-reply decision. `escalateToHuman` needs the
      // same two calls, and two copies of it would drift the moment either the
      // subject rule or the payload shape changed.
      await openOrReply(t);
    } catch (e: any) {
      setError(e.message || 'Could not send. Try one of the channels below.');
      // The optimistic line is removed rather than left looking delivered.
      setMsgs(prev => prev.slice(0, -1));
      setText(t);
    } finally { setBusy(false); }
  };

  const statusLine = loading ? 'Loading…'
    : ticket ? `Ticket ${ticket.ticketId.slice(0, 8)} · ${String(ticket.status || 'OPEN').toLowerCase()}`
    // Says which one is about to answer, so nobody is surprised by a robot.
    : assistantOn ? 'Assistant answers first · a person is one tap away'
    : 'Send a message to open a ticket';

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 130, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(2px)' }} />
      <div className="bb-rise" style={{ position: 'absolute', right: 0, bottom: 0, top: 0, zIndex: 131, width: 'min(94vw,420px)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--line2)', boxShadow: '-20px 0 50px -12px rgba(0,0,0,.6)' }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 11, padding: '16px 16px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'color-mix(in srgb,var(--gold) 14%,var(--surface3))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🛟</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Support</div>
            {/* The ticket's real state. Never an invented "agent online". */}
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLine}</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!loading && msgs.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: '20px 8px', lineHeight: 1.5 }}>
              Describe your problem and we will open a support ticket.<br />
              You will see replies here, and the channels behind this panel reach us faster.
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.me ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '78%' }}>
                {/* An assistant reply is labelled as one. A player deciding what
                    to do about their money must never mistake it for a person. */}
                {!m.me && <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: m.assistant ? 'var(--gold)' : 'var(--text3)', margin: '0 0 3px 4px' }}>{m.assistant ? 'ASSISTANT · AUTOMATED' : m.who}</div>}
                <div style={{ padding: '10px 13px', borderRadius: 14, background: m.me ? 'linear-gradient(135deg,var(--gold2),var(--gold))' : 'var(--surface3)', color: m.me ? '#1a1200' : 'var(--text)', fontSize: 13, lineHeight: 1.45, boxShadow: 'var(--shadow-sm)' }}>{m.t}</div>
              </div>
            </div>
          ))}
          {/* Always reachable after the assistant answers, whether it helped or
              not. The typed question is carried into the ticket, so escalating
              costs one tap and nothing is retyped. */}
          {escalate && (
            <button onClick={escalateToHuman} disabled={busy} style={{ alignSelf: 'center', marginTop: 2, padding: '9px 16px', borderRadius: 999, border: '1px solid var(--line2)', background: 'var(--surface3)', color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: busy ? .6 : 1 }}>
              {busy ? 'Sending…' : ticket ? 'Send this to support too' : "This didn't answer it — talk to a person"}
            </button>
          )}
          {error && <div style={{ fontSize: 11, color: 'var(--red)', textAlign: 'center' }}>{error}</div>}
          <div ref={bottom} />
        </div>
        <div style={{ flex: 'none', padding: '12px 14px', borderTop: '1px solid var(--line)', display: 'flex', gap: 9, alignItems: 'center', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} disabled={busy} placeholder={busy ? 'Sending…' : 'Describe your problem…'} style={{ flex: 1, height: 44, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 999, padding: '0 16px', color: 'var(--text)', fontSize: 13, outline: 'none', opacity: busy ? .6 : 1 }} />
          <button onClick={send} disabled={busy || !text.trim()} style={{ width: 44, height: 44, flex: 'none', borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', fontSize: 17, opacity: (busy || !text.trim()) ? .5 : 1 }}>➤</button>
        </div>
      </div>
    </>
  );
};

const SupportPage: React.FC = () => {
  const navigate = useNavigate();
  const [links, setLinks] = useState<SupportLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    (backend as any).getSupportLinks?.()
      .then((data: any) => {
        const d = data?.links ?? data;
        if (d) setLinks({ whatsapp: d.whatsapp || '', telegram: d.telegram || d.telegramUsername || '', telegramGroupUrl: d.telegramGroupUrl || '', telegramChannelUrl: d.telegramChannelUrl || '', instagram: d.instagram || '', youtube: d.youtube || '', email: d.email || '' });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const channels = links ? [
    links.whatsapp && { icon: '💬', label: 'WhatsApp', sub: 'Chat with Support', href: `https://wa.me/${links.whatsapp.replace(/\D/g, '')}`, tag: '9am–11pm', tagBg: 'var(--green)' },
    links.telegram && { icon: '✈️', label: 'Telegram', sub: 'Message support', href: links.telegram.startsWith('http') ? links.telegram : `https://t.me/${links.telegram.replace('@', '')}`, tag: 'Fast', tagBg: 'var(--bombay)' },
    links.telegramGroupUrl && { icon: '👥', label: 'Telegram Group', sub: 'Join the community', href: links.telegramGroupUrl, tag: 'Community', tagBg: 'var(--bombay)' },
    links.telegramChannelUrl && { icon: '📢', label: 'Telegram Channel', sub: 'Announcements', href: links.telegramChannelUrl, tag: 'News', tagBg: 'var(--bombay)' },
    links.instagram && { icon: '📸', label: 'Instagram', sub: 'Follow us', href: links.instagram.startsWith('http') ? links.instagram : `https://instagram.com/${links.instagram.replace('@', '')}`, tag: 'Follow', tagBg: '#E1306C' },
    links.youtube && { icon: '▶️', label: 'YouTube', sub: 'Watch tutorials', href: links.youtube, tag: 'Watch', tagBg: 'var(--red)' },
    links.email && { icon: '📧', label: 'Email', sub: links.email, href: `mailto:${links.email}`, tag: '~24h', tagBg: 'var(--text3)' },
  ].filter(Boolean) as Array<{ icon: string; label: string; sub: string; href: string; tag: string; tagBg: string }> : [];

  return (
    <ScreenShell icon="🛟" title="Support" sub="We are here to help">
      <button onClick={() => setChatOpen(true)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: 16, borderRadius: 16, border: 'none', cursor: 'pointer', textAlign: 'left', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', boxShadow: '0 10px 26px -10px var(--glow)', marginBottom: 14 }}>
        <span style={{ fontSize: 24 }}>💬</span>
        <span style={{ flex: 1 }}><span className="font-grotesk" style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>Message Support</span><span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .75 }}>Open a support ticket · we reply here</span></span>
        <span style={{ fontSize: 18 }}>›</span>
      </button>

      {loading && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text3)', fontSize: 12 }}>Loading support contacts…</div>}
      {!loading && channels.length === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: '28px 16px' }}><div style={{ fontSize: 34, marginBottom: 8 }}>📭</div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Support contacts not configured</div><div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Please check back later.</div></div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
        {channels.map((c, i) => (
          <a key={i} href={c.href} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 12, ...card, padding: 14, textDecoration: 'none' }}>
            <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>{c.icon}</span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{c.label}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</span></span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '4px 9px', borderRadius: 999, color: '#fff', background: c.tagBg }}>{c.tag}</span>
          </a>
        ))}
      </div>

      <div style={{ ...card, marginTop: 14, textAlign: 'center' }}>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>Support available <b style={{ color: 'var(--text2)' }}>9 AM – 11 PM IST</b>, 7 days a week.</p>
      </div>
      <button onClick={() => navigate('/faq')} style={{ width: '100%', marginTop: 12, background: 'color-mix(in srgb,var(--gold) 10%,transparent)', border: '1px solid var(--line2)', borderRadius: 14, padding: 14, color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>❓ View FAQ / Help Articles</button>

      {chatOpen && <SupportChat onClose={() => setChatOpen(false)} />}
    </ScreenShell>
  );
};

export default SupportPage;

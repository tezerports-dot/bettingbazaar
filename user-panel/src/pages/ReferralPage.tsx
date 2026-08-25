// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ReferralPage.tsx — the whole referral story, in one place.
 *
 * ── Why none of this lives on the wallet screen ─────────────────────────────
 * Only the DISBURSED portion ever reaches the winnings wallet. Everything else
 * is a promise whose value depends on other people's KYC and on when the
 * operator next funds the queue. Folding an unrealised promise into a balance
 * is how a player comes to believe they hold money they cannot withdraw — the
 * same class of mistake as counting the reserve as spendable.
 *
 * ── Four numbers, deliberately separated ────────────────────────────────────
 *   Paid to winnings   — already in the wallet. Real, withdrawable.
 *   Next disbursal     — confirmed and owed, waiting only on the operator.
 *   Awaiting KYC       — the invited player has not been verified yet. NOT
 *                        theirs, and shown apart so it cannot be mistaken for
 *                        income.
 *   Not payable        — voided (a failed KYC upstream) or otherwise blocked.
 *
 * ── What a referrer sees about the people they invited ──────────────────────
 * A joining number, and nothing else. No name, no phone, no Aadhaar. The
 * joining number is already the queue key, so it is the one identifier that has
 * to be visible for the payout order to be checkable by the person waiting in
 * it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ScreenShell, { card } from '../redesign/Screen';
import { apiClient } from '../services/apiClient';
import { apiUrl } from '../services/apiUrl';

interface LevelTotals {
  count: number; confirmed: number; awaitingKyc: number; disbursed: number; blocked: number;
}
interface Row {
  joiningNumber: number; level: 1 | 2; amount: number;
  kyc: 'PENDING_VERIFICATION' | 'VERIFIED' | 'FAILED';
  status: 'PENDING' | 'DISBURSED' | 'BLOCKED';
  reason: string; disbursedAt: string | null;
}
interface Summary {
  referralCode: string;
  joiningNumber: number | null;
  rewardPerReferral: number;
  level1: LevelTotals;
  level2: LevelTotals;
  totals: {
    referrals: number; confirmed: number; disbursed: number;
    nextDisbursal: number; awaitingKyc: number; blocked: number;
  };
  rows: Row[];
}

const inr = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** One row's state, in the words a player would use. */
function rowState(r: Row): { label: string; tone: string } {
  if (r.status === 'DISBURSED') return { label: 'Paid', tone: 'var(--green)' };
  if (r.status === 'BLOCKED' || r.kyc === 'FAILED') return { label: 'Not payable', tone: 'var(--red)' };
  if (r.kyc === 'VERIFIED') return { label: 'Ready to pay', tone: 'var(--gold-ink)' };
  return { label: 'Awaiting their KYC', tone: 'var(--text3)' };
}

const ReferralPage: React.FC = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [bot, setBot] = useState<string>('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res: any = await apiClient.get('/api/user/referrals');
      if (res?.success) setData(res as Summary);
      else setError(res?.message || 'Could not load your referral report.');
    } catch (e: any) {
      setError(e?.message || 'Could not load your referral report.');
    }
    // The bot's @username is fetched, never hardcoded: a suspended bot is
    // replaced from the admin panel, and a baked-in link would send every
    // invited player to a dead chat until the app was rebuilt.
    try {
      const r = await fetch(apiUrl('/api/telegram/public-config'), { credentials: 'include' });
      const d = await r.json();
      if (d?.success) setBot(d.botUsername || '');
    } catch { /* the report is still useful without a link */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Deep link: Telegram passes ?start=<code> straight to the bot, so the invited
  // player never types a code and cannot mistype one.
  const link = bot && data?.referralCode ? `https://t.me/${bot}?start=${encodeURIComponent(data.referralCode)}` : '';

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the link is on screen to copy by hand */ }
  };

  if (error) {
    return (
      <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players, earn on two levels">
        <div style={{ ...card, borderColor: 'var(--red)', color: 'var(--red)', fontSize: 13 }} role="alert">{error}</div>
      </ScreenShell>
    );
  }

  if (!data) {
    return (
      <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players, earn on two levels">
        <div style={{ ...card, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }} aria-busy="true">Loading…</div>
      </ScreenShell>
    );
  }

  const t = data.totals;

  return (
    <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players, earn on two levels">
      {/* ── Your link ─────────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 8 }}>
          Your invite link
        </div>
        {link ? (
          <>
            <div className="font-grotesk" style={{ fontSize: 12, wordBreak: 'break-all', background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 11, padding: '10px 12px', color: 'var(--text2)' }}>
              {link}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={copy} style={{ flex: 1, height: 42, borderRadius: 11, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))' }}>
                {copied ? 'COPIED' : 'COPY LINK'}
              </button>
              <a
                href={`https://t.me/share/url?url=${encodeURIComponent(link)}`}
                target="_blank" rel="noopener noreferrer"
                style={{ flex: 1, height: 42, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', fontWeight: 800, fontSize: 13, color: 'var(--text)', background: 'var(--surface2)', border: '1px solid var(--line2)' }}
              >
                SHARE
              </a>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
            Your link will appear here once sign-in is configured.
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12, fontSize: 11, color: 'var(--text3)' }}>
          <span>Code <strong className="font-grotesk" style={{ color: 'var(--gold-ink)' }}>{data.referralCode || '—'}</strong></span>
          {data.joiningNumber != null && (
            <span>You are joiner <strong className="font-grotesk" style={{ color: 'var(--text2)' }}>#{data.joiningNumber.toLocaleString('en-IN')}</strong></span>
          )}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          Opening the link starts our bot with your code already attached — the person you
          invite never has to type it. You earn {inr(data.rewardPerReferral)} when they join,
          and {inr(data.rewardPerReferral)} again when someone <em>they</em> invite joins.
        </p>
      </div>

      {/* ── The four numbers ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginBottom: 14 }}>
        {[
          { k: 'Paid to winnings', v: t.disbursed, tone: 'var(--green)', sub: 'Already in your wallet' },
          { k: 'Next disbursal',   v: t.nextDisbursal, tone: 'var(--gold-ink)', sub: 'Confirmed, awaiting payout' },
          { k: 'Awaiting their KYC', v: t.awaitingKyc, tone: 'var(--text2)', sub: 'Not yours yet' },
          { k: 'Not payable',      v: t.blocked, tone: t.blocked > 0 ? 'var(--red)' : 'var(--text3)', sub: 'Voided or blocked' },
        ].map((c) => (
          <div key={c.k} style={card}>
            <div style={{ fontSize: 10.5, color: 'var(--text3)', fontWeight: 700 }}>{c.k}</div>
            <div className="font-grotesk" style={{ fontSize: 21, fontWeight: 800, marginTop: 5, color: c.tone }}>{inr(c.v)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Level split ───────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 10 }}>
          By level
        </div>
        {([['Level 1 — you invited them', data.level1], ['Level 2 — they invited them', data.level2]] as const).map(([label, lv]) => (
          <div key={label} style={{ padding: '11px 0', borderTop: '1px solid var(--line2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{label}</span>
              <span className="font-grotesk" style={{ fontSize: 15, fontWeight: 800, color: 'var(--gold-ink)' }}>{inr(lv.confirmed)}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
              {lv.count} referral{lv.count === 1 ? '' : 's'} · {inr(lv.disbursed)} paid · {inr(lv.awaitingKyc)} awaiting KYC
              {lv.blocked > 0 && <> · {inr(lv.blocked)} not payable</>}
            </div>
          </div>
        ))}
      </div>

      {/* ── Every referral, in queue order ────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 4 }}>
          Your referrals
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--text3)', lineHeight: 1.55 }}>
          Listed by joining number, which is also the payout order — the queue pays earliest
          joiners first. We show only their joining number, never their name or contact.
        </p>

        {data.rows.length === 0 ? (
          <div style={{ padding: '26px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--text3)' }}>
            No referrals yet. Share your link above to get started.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
              <thead>
                <tr>
                  {['Joiner', 'Level', 'Reward', 'Status'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', padding: '0 10px 8px 0', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = rowState(r);
                  return (
                    <tr key={`${r.joiningNumber}-${r.level}`} style={{ borderTop: '1px solid var(--line2)' }}>
                      <td className="font-grotesk" style={{ padding: '10px 10px 10px 0', fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>#{r.joiningNumber.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '10px 10px 10px 0', fontSize: 11.5, color: 'var(--text2)' }}>L{r.level}</td>
                      <td className="font-grotesk" style={{ padding: '10px 10px 10px 0', fontSize: 12.5, color: 'var(--text2)' }}>{inr(r.amount)}</td>
                      <td style={{ padding: '10px 0', fontSize: 11, fontWeight: 700, color: st.tone }}>
                        {st.label}
                        {r.reason && <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text3)', marginTop: 2 }}>{r.reason}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ScreenShell>
  );
};

export default ReferralPage;

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ReferralPage.tsx — the whole referral story, in one place.
 *
 * ── Why none of this lives on the wallet screen ─────────────────────────────
 * Only the DISBURSED portion ever reaches the General balance. Everything else
 * is a promise whose value depends on when the operator next funds the queue. Folding an unrealised promise into a balance
 * is how a player comes to believe they hold money they cannot withdraw — the
 * same class of mistake as counting the reserve as spendable.
 *
 * ── Three numbers, deliberately separated ───────────────────────────────────
 *   Paid to General    — in the General balance; withdrawable once its 10×
 *                        turnover is played (owner, 2026-10-08).
 *   Next disbursal     — confirmed and owed, waiting only on the operator.
 *   Not payable        — voided or otherwise blocked.
 *
 * There was a fourth, "Awaiting KYC". KYC was removed (owner, 2026-10-02), and
 * the server no longer sends it.
 *
 * ── Layout (owner, 2026-10-15: "redesign it beautifully") ───────────────────
 * A hero banner with the reward and the link to share (its picture is
 * Admin › Images › Page banners › `referPageBannerUrl`; with none it draws its
 * own gold banner), the link's reach, how it works in three steps, earnings
 * and the per-level split, then every referral. Every figure is the server's.
 *
 * ── What a referrer sees about the people they invited ──────────────────────
 * Nothing that identifies them: no name, no phone and no joining number
 * (owner, 2026-10-14). Each row is a level, a reward and its state, newest
 * first.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ScreenShell, { card, capLabel } from '../redesign/Screen';
import BonusPlayPrompt from '../redesign/BonusPlayPrompt';
import { player } from '../services/api';
import { getAssetUrl, getBackend } from '../services/backend.service';

interface LevelTotals {
  count: number; confirmed: number; disbursed: number; blocked: number;
}
interface Row {
  level: 1 | 2; amount: number;
  status: 'PENDING' | 'DISBURSED' | 'BLOCKED';
  reason: string; disbursedAt: string | null;
}
interface Summary {
  referralCode: string;
  rewardPerReferral: number;
  /** What the second level earns per joiner now (referral.service.js `rewardLevel2`). */
  rewardLevel2: number;
  level1: LevelTotals;
  level2: LevelTotals;
  totals: {
    referrals: number; confirmed: number; disbursed: number;
    nextDisbursal: number; blocked: number;
    /** People who opened the link, deduplicated per viewer per day. */
    clicks: number;
  };
  rows: Row[];
}

const inr = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** One row's state, in the words a player would use. */
function rowState(r: Row): { label: string; tone: string } {
  if (r.status === 'DISBURSED') return { label: 'Paid', tone: 'var(--green)' };
  if (r.status === 'BLOCKED') return { label: 'Not payable', tone: 'var(--red)' };
  return { label: 'Ready to pay', tone: 'var(--gold-ink)' };
}

const ReferralPage: React.FC = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [bot, setBot] = useState<string>('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res: any = await player.referrals();
      if (res?.success) setData(res as Summary);
      else setError(res?.message || 'Could not load your referral report.');
    } catch (e: any) {
      setError(e?.message || 'Could not load your referral report.');
    }
    // Only to SHOW which bot the link currently opens. It is deliberately not
    // part of the link itself — see below.
    try {
      const d = await getBackend().getTelegramSetup();
      setBot(d.available ? d.botUsername : '');
    } catch { /* the report and the link both work without this */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The shared link points at OUR domain, never at t.me.
   *
   * This used to be `https://t.me/<bot>?start=<code>`, built from whichever bot
   * was live when the page loaded. That link then leaves — into WhatsApp, into
   * forwards, into screenshots — and lives for months somewhere nobody can
   * reach. It names one specific bot.
   *
   * Telegram suspends gambling bots, and replacing one is a single click in the
   * admin panel by design. But every link already shared would still name the
   * DEAD bot: the invited player taps it, Telegram says the bot does not exist,
   * and the referrer silently loses a signup they had earned. Nobody reports
   * "the link I sent my cousin last month is broken", so the platform's referral
   * numbers would just quietly stop meaning anything.
   *
   * `/r/<code>` redirects to whichever bot is live at the moment of the tap, so
   * the link never has to change — it never named a bot in the first place.
   * The Mini App receives the code as its signed start parameter (`ref-CODE`)
   * and locks it on the signup form, so the invited player types nothing.
   */
  const link = data?.referralCode
    ? `${window.location.origin}/r/${encodeURIComponent(data.referralCode)}`
    : '';

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
  const branding = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const banner = getAssetUrl(branding.referPageBannerUrl || '');
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const shareText = `Join me on ${branding.appName || 'Bazaar'}: ${link}`;
  const nativeShare = async () => {
    try { await navigator.share({ title: 'Refer & Earn', text: shareText, url: link }); } catch { /* dismissed */ }
  };
  const conversion = t.clicks > 0 ? Math.round((t.referrals / t.clicks) * 100) : null;
  const levelMax = Math.max(1, data.level1.confirmed, data.level2.confirmed);

  const shareBtn: React.CSSProperties = { flex: '1 1 0', minWidth: 96, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, textDecoration: 'none', fontWeight: 800, fontSize: 12.5, cursor: 'pointer', color: '#fff', background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.28)', backdropFilter: 'blur(6px)' };

  return (
    <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players, earn on two levels">
      <BonusPlayPrompt />

      {/* ── Hero: the reward and the link ─────────────────────────────── */}
      <section aria-label="Your invite" style={{ position: 'relative', overflow: 'hidden', borderRadius: 22, marginBottom: 16, boxShadow: 'var(--shadow)', border: '1px solid var(--line2)', background: banner ? 'var(--surface)' : 'radial-gradient(120% 140% at 0% 0%, var(--gold2) 0%, var(--gold) 38%, color-mix(in srgb,var(--gold) 45%,var(--bg)) 100%)' }}>
        {banner && <img src={banner} alt="" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: banner ? 'linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.72) 70%)' : 'radial-gradient(circle at 88% 18%, rgba(255,255,255,.28) 0 60px, transparent 61px), radial-gradient(circle at 96% 70%, rgba(255,255,255,.14) 0 90px, transparent 91px), linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.35) 100%)' }} />
        <div style={{ position: 'relative', padding: 'clamp(18px, 4vw, 30px)', color: '#fff' }}>
          <div style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, background: 'rgba(0,0,0,.28)', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>Two levels of rewards</div>
          <h2 className="font-grotesk" style={{ margin: '12px 0 6px', fontWeight: 700, fontSize: 'clamp(24px, 5vw, 36px)', lineHeight: 1.1, textShadow: '0 2px 12px rgba(0,0,0,.35)' }}>
            Earn {inr(data.rewardPerReferral)} for every friend who joins
          </h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.92, maxWidth: 560 }}>
            {data.rewardLevel2 > 0
              ? <>Plus {inr(data.rewardLevel2)} each time someone <em>they</em> invite joins. Rewards go to your General balance.</>
              : <>Rewards go to your General balance.</>}
          </p>

          {link ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18, padding: 6, paddingLeft: 14, borderRadius: 14, background: 'rgba(0,0,0,.38)', border: '1px solid rgba(255,255,255,.22)', maxWidth: 620 }}>
                <span className="font-grotesk" style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={link}>{link}</span>
                <button type="button" onClick={copy} style={{ flex: 'none', height: 38, padding: '0 16px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 12.5, color: 'var(--on-gold)', background: 'var(--gold-metal)' }}>
                  {copied ? 'Copied ✓' : 'Copy link'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, maxWidth: 620 }}>
                <a href={`https://t.me/share/url?url=${encodeURIComponent(link)}`} target="_blank" rel="noopener noreferrer" style={shareBtn}>✈ Telegram</a>
                <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer" style={shareBtn}>💬 WhatsApp</a>
                {canShare && <button type="button" onClick={nativeShare} style={shareBtn}>↗ More</button>}
              </div>
            </>
          ) : (
            <p style={{ margin: '16px 0 0', fontSize: 12, opacity: 0.9 }}>Your link will appear here once sign-in is configured.</p>
          )}
          <div style={{ marginTop: 12, fontSize: 11, opacity: 0.85 }}>
            Your code <strong className="font-grotesk" style={{ letterSpacing: '.06em' }}>{data.referralCode || '—'}</strong>
          </div>
        </div>
      </section>

      {/* ── Reach and earnings at a glance ────────────────────────────── */}
      {/*
        Clicks beside signups, because the gap between them is the one number
        that tells a referrer which half is broken: nobody is opening the link,
        or everybody opens it and stops at the bot.
      */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { k: 'Opened your link', v: (t.clicks ?? 0).toLocaleString('en-IN'), ic: '👀', tone: 'var(--text)', sub: 'people, once a day each' },
          { k: 'Signed up', v: (t.referrals ?? 0).toLocaleString('en-IN'), ic: '🙌', tone: 'var(--gold-ink)', sub: conversion === null ? 'from your link' : `${conversion}% of those who opened it` },
          { k: 'Paid to General', v: inr(t.disbursed), ic: '✅', tone: 'var(--green)', sub: 'unlocks once its turnover is played' },
          { k: 'Next disbursal', v: inr(t.nextDisbursal), ic: '⏳', tone: 'var(--gold-ink)', sub: 'confirmed, awaiting payout' },
        ].map((c) => (
          <div key={c.k} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span aria-hidden style={{ width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, background: 'color-mix(in srgb,var(--gold) 12%,var(--surface2))', border: '1px solid var(--line2)' }}>{c.ic}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', marginTop: 4 }}>{c.k}</span>
            <span className="font-grotesk" style={{ fontSize: 22, fontWeight: 800, color: c.tone, lineHeight: 1.1 }}>{c.v}</span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{c.sub}</span>
          </div>
        ))}
      </div>
      {t.blocked > 0 && (
        <div style={{ ...card, padding: '10px 14px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', gap: 10, borderColor: 'color-mix(in srgb,var(--red) 40%,var(--line))' }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Not payable (voided or blocked)</span>
          <span className="font-grotesk" style={{ fontSize: 14, fontWeight: 800, color: 'var(--red)' }}>{inr(t.blocked)}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginBottom: 16 }}>
        {/* ── How it works ────────────────────────────────────────────── */}
        <section aria-label="How it works" style={card}>
          <span style={capLabel}>How it works</span>
          <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { t: 'Share your link', d: 'Send it anywhere. It opens our sign-up bot with your code already attached, so your friend never types it.' },
              { t: 'They continue with Telegram', d: `When they join you earn ${inr(data.rewardPerReferral)}.` },
              { t: 'Their friends count too', d: data.rewardLevel2 > 0 ? `Each person they invite earns you ${inr(data.rewardLevel2)} more.` : 'Second-level rewards are switched off right now.' },
            ].map((step, i) => (
              <li key={step.t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span className="font-grotesk" style={{ flex: 'none', width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, color: 'var(--on-gold)', background: 'var(--gold-metal)' }}>{i + 1}</span>
                <span>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{step.t}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.55, marginTop: 2 }}>{step.d}</span>
                </span>
              </li>
            ))}
          </ol>
          <p style={{ margin: '14px 0 0', paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
            Your link is permanent{bot ? <> and opens <strong style={{ color: 'var(--text2)' }}>@{bot}</strong> today</> : ''}. If we ever switch to a different sign-up bot it keeps working and sends people to the new one, so anything you have already shared stays good.
          </p>
        </section>

        {/* ── Level split ─────────────────────────────────────────────── */}
        <section aria-label="Earnings by level" style={card}>
          <span style={capLabel}>Earnings by level</span>
          {([['Level 1', 'people you invited', data.level1], ['Level 2', 'people they invited', data.level2]] as const).map(([label, who, lv]) => (
            <div key={label} style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{label} <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>· {who}</span></span>
                <span className="font-grotesk" style={{ fontSize: 16, fontWeight: 800, color: 'var(--gold-ink)' }}>{inr(lv.confirmed)}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--surface3)', overflow: 'hidden', marginTop: 8, border: '1px solid var(--line)' }}>
                <div style={{ height: '100%', width: `${Math.round((lv.confirmed / levelMax) * 100)}%`, background: 'linear-gradient(90deg,var(--gold),var(--gold2))', borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                {lv.count} referral{lv.count === 1 ? '' : 's'} · {inr(lv.disbursed)} paid
                {lv.blocked > 0 && <> · {inr(lv.blocked)} not payable</>}
              </div>
            </div>
          ))}
        </section>
      </div>

      {/* ── Every referral, newest first ──────────────────────────────── */}
      <section aria-label="Your referrals" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={capLabel}>Your referrals</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Newest first. We never show who they are.</span>
        </div>
        {data.rows.length === 0 ? (
          <div style={{ padding: '30px 0 18px', textAlign: 'center' }}>
            <div aria-hidden style={{ fontSize: 30 }}>🎁</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginTop: 6 }}>No referrals yet</div>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>Share your link above to get started.</div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
            {data.rows.map((r, i) => {
              const st = rowState(r);
              return (
                <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line)' }}>
                  <span className="font-grotesk" style={{ flex: 'none', width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text2)', background: 'var(--surface2)', border: '1px solid var(--line2)' }}>L{r.level}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="font-grotesk" style={{ display: 'block', fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{inr(r.amount)}</span>
                    {r.reason && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text3)', marginTop: 1 }}>{r.reason}</span>}
                  </span>
                  <span style={{ flex: 'none', padding: '4px 10px', borderRadius: 999, fontSize: 10.5, fontWeight: 800, color: st.tone, background: `color-mix(in srgb,${st.tone} 12%,transparent)`, border: `1px solid color-mix(in srgb,${st.tone} 35%,transparent)` }}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </ScreenShell>
  );
};

export default ReferralPage;

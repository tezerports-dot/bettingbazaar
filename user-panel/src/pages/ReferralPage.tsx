// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ReferralPage.tsx — the whole referral story, in one place.
 *
 * ── Why none of this lives on the wallet screen ─────────────────────────────
 * Only the DISBURSED portion ever reaches the General balance. Everything else
 * is owed and paid within a minute (the `referral-autopay` cron), or blocked. Folding an unpaid promise into a balance
 * is how a player comes to believe they hold money they cannot withdraw — the
 * same class of mistake as counting the reserve as spendable.
 *
 * ── Three numbers, deliberately separated ───────────────────────────────────
 *   Paid to General    — in the General balance; withdrawable once its 10×
 *                        turnover is played (owner, 2026-10-08).
 *   Being paid         — confirmed and owed, paid within a minute.
 *   Not payable        — voided or otherwise blocked.
 *
 * There was a fourth, "Awaiting KYC". KYC was removed (owner, 2026-10-02), and
 * the server no longer sends it.
 *
 * ── Layout (owner, 2026-10-15: "redesign it beautifully") ───────────────────
 * A hero banner with the reward and the link to share (its picture is
 * Admin › Images › Page banners › `referPageBannerUrl`; with none it draws its
 * own gold banner), the link's reach, the invite tree (each level, its bonus
 * per joiner and its people; owner, 2026-10-20), income by level with a total
 * line, how it works, then every referral. Every figure is the server's: the
 * bonus per level is Admin › System Settings › Referral Rewards as it is now.
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
import { getAssetUrl } from '../services/backend.service';
import { useBranding } from '../services/branding';

/** One level of the invite chain (referral.service.js `levels`), level 1 first. */
interface LevelTotals {
  level: number;
  /** What a new joiner earns at this level now; 0 = off. */
  reward: number;
  count: number; confirmed: number; disbursed: number; blocked: number;
}
interface Row {
  level: number; amount: number;
  status: 'PENDING' | 'DISBURSED' | 'BLOCKED';
  reason: string; disbursedAt: string | null;
}
interface Summary {
  referralCode: string;
  levels: LevelTotals[];
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
  return { label: 'Being paid', tone: 'var(--gold-ink)' };
}

const ReferralPage: React.FC = () => {
  // The page banner (Admin › Images), redrawn on a save.
  const branding = useBranding();
  const [data, setData] = useState<Summary | null>(null);
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
    // The bot's username is never shown to players (owner, 2026-10-24): it is
    // an internal name, and the link below never names it either.
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
      <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players and earn">
        <div style={{ ...card, borderColor: 'var(--red)', color: 'var(--red)', fontSize: 13 }} role="alert">{error}</div>
      </ScreenShell>
    );
  }

  if (!data) {
    return (
      <ScreenShell icon="🎁" title="Refer & Earn" sub="Invite players and earn">
        <div style={{ ...card, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }} aria-busy="true">Loading…</div>
      </ScreenShell>
    );
  }

  const t = data.totals;
  const banner = getAssetUrl(String(branding.referPageBannerUrl || ''));
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const shareText = `Join me on ${branding.appName || 'Bazaar'}: ${link}`;
  const nativeShare = async () => {
    try { await navigator.share({ title: 'Refer & Earn', text: shareText, url: link }); } catch { /* dismissed */ }
  };
  const conversion = t.clicks > 0 ? Math.round((t.referrals / t.clicks) * 100) : null;
    const paying = data.levels.filter((l) => l.reward > 0);
  const level1Reward = data.levels[0]?.reward ?? 0;
  // The levels after the first that pay, for the hero line ("₹10 at level 2 · ₹5 at level 3").
  const deeper = paying.filter((l) => l.level > 1);
  const levelsSub = paying.length > 1 ? `Invite players, earn on ${paying.length} levels` : 'Invite players and earn';
  const whoAt = (n: number) => (n === 1 ? 'people you invited' : n === 2 ? 'people they invited' : `${n - 1} steps further down`);

  const shareBtn: React.CSSProperties = { flex: '1 1 0', minWidth: 96, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, textDecoration: 'none', fontWeight: 800, fontSize: 12.5, cursor: 'pointer', color: '#fff', background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.28)', backdropFilter: 'blur(6px)' };

  return (
    <ScreenShell icon="🎁" title="Refer & Earn" sub={levelsSub}>
      <BonusPlayPrompt />

      {/* ── Hero: the reward and the link ─────────────────────────────── */}
      <section aria-label="Your invite" style={{ position: 'relative', overflow: 'hidden', borderRadius: 22, marginBottom: 16, boxShadow: 'var(--shadow)', border: '1px solid var(--line2)', background: banner ? 'var(--surface)' : 'radial-gradient(120% 140% at 0% 0%, var(--gold2) 0%, var(--gold) 38%, color-mix(in srgb,var(--gold) 45%,var(--bg)) 100%)' }}>
        {banner && <img src={banner} alt="" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: banner ? 'linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.72) 70%)' : 'radial-gradient(circle at 88% 18%, rgba(255,255,255,.28) 0 60px, transparent 61px), radial-gradient(circle at 96% 70%, rgba(255,255,255,.14) 0 90px, transparent 91px), linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.35) 100%)' }} />
        <div style={{ position: 'relative', padding: 'clamp(18px, 4vw, 30px)', color: '#fff' }}>
          <div style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, background: 'rgba(0,0,0,.28)', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>{paying.length > 1 ? `${paying.length} levels of rewards` : 'Invite and earn'}</div>
          <h2 className="font-grotesk" style={{ margin: '12px 0 6px', fontWeight: 700, fontSize: 'clamp(24px, 5vw, 36px)', lineHeight: 1.1, textShadow: '0 2px 12px rgba(0,0,0,.35)' }}>
            Earn {inr(level1Reward)} for every friend who joins
          </h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.92, maxWidth: 560 }}>
            {deeper.length > 0
              ? <>Plus {deeper.map((l) => `${inr(l.reward)} at level ${l.level}`).join(' · ')} when people further down your invite chain join. Rewards go to your General balance.</>
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
          { k: 'Being paid', v: inr(t.nextDisbursal), ic: '⏳', tone: 'var(--gold-ink)', sub: 'paid to General within a minute' },
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

      {/* ── The invite tree: every level, its bonus, its people ──────── */}
      <ReferralTree levels={data.levels} whoAt={whoAt} />

      {/* ── Income by level ──────────────────────────────────────────── */}
      <IncomeByLevel levels={data.levels} whoAt={whoAt} />

      <div style={{ marginBottom: 16 }}>
        {/* ── How it works ────────────────────────────────────────────── */}
        <section aria-label="How it works" style={card}>
          <span style={capLabel}>How it works</span>
          <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { t: 'Share your link', d: 'Send it anywhere. It opens our sign-up bot with your code already attached, so your friend never types it.' },
              { t: 'They continue with Telegram', d: `When they join you earn ${inr(level1Reward)}.` },
              { t: 'Their friends count too', d: deeper.length > 0 ? `People they invite earn you more: ${deeper.map((l) => `${inr(l.reward)} at level ${l.level}`).join(', ')}.` : 'Rewards for deeper levels are switched off right now.' },
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
            Your link is permanent. If we ever switch to a different sign-up bot it keeps working and sends people to the new one, so anything you have already shared stays good.
          </p>
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

/** The invite chain as a tree: you at the root, each level a branch below the one before. */
const ReferralTree: React.FC<{ levels: LevelTotals[]; whoAt: (n: number) => string }> = ({ levels, whoAt }) => (
  <section aria-label="Your referral tree" style={{ ...card, marginBottom: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <span style={capLabel}>Your referral tree</span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{levels.length} level{levels.length === 1 ? '' : 's'} · bonus per person who joins</span>
    </div>
    <ol style={{ listStyle: 'none', margin: '14px 0 0', padding: 0 }}>
      <li style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden className="font-grotesk" style={{ width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, color: 'var(--on-gold)', background: 'var(--gold-metal)', boxShadow: '0 6px 18px -8px var(--glow)' }}>YOU</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>You</span>
      </li>
      {levels.map((lv, i) => {
        const on = lv.reward > 0;
        const tone = on ? 'var(--gold-ink)' : 'var(--text3)';
        return (
          <li key={lv.level} data-testid={`tree-level-${lv.level}`}
            style={{ position: 'relative', marginLeft: 19 + i * 18, paddingLeft: 26, paddingTop: 12 }}>
            {/* The branch: down from the node above, then across to this one. */}
            <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, height: 36, width: 20, borderLeft: '2px solid var(--line2)', borderBottom: '2px solid var(--line2)', borderBottomLeftRadius: 10 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 14, background: on ? 'color-mix(in srgb,var(--gold) 8%,var(--surface2))' : 'var(--surface2)', border: `1px solid ${on ? 'color-mix(in srgb,var(--gold) 35%,var(--line2))' : 'var(--line2)'}` }}>
              <span className="font-grotesk" style={{ flex: 'none', width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: tone, background: 'var(--surface)', border: '1px solid var(--line2)' }}>L{lv.level}</span>
              <span style={{ flex: '1 1 140px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Level {lv.level}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>{whoAt(lv.level)}</span>
              </span>
              <span style={{ textAlign: 'right' }}>
                <span className="font-grotesk" style={{ display: 'block', fontSize: 16, fontWeight: 800, color: tone }}>{on ? `${inr(lv.reward)} each` : 'Off'}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>
                  {lv.count} {lv.count === 1 ? 'person' : 'people'} · {inr(lv.confirmed)} earned
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  </section>
);

/** What each level has paid: people, earned, paid, waiting, not payable, with a total line. */
const IncomeByLevel: React.FC<{ levels: LevelTotals[]; whoAt: (n: number) => string }> = ({ levels, whoAt }) => {
  const total = levels.reduce((t, l) => ({
    count: t.count + l.count, confirmed: t.confirmed + l.confirmed, disbursed: t.disbursed + l.disbursed, blocked: t.blocked + l.blocked,
  }), { count: 0, confirmed: 0, disbursed: 0, blocked: 0 });
  const th: React.CSSProperties = { padding: '10px 12px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text3)', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--line2)' };
  const td: React.CSSProperties = { padding: '11px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--line)' };
  const money = (n: number, tone: string) => <span className="font-grotesk" style={{ fontWeight: 800, color: n > 0 ? tone : 'var(--text3)' }}>{inr(n)}</span>;
  return (
    <section aria-label="Referral income by level" style={{ ...card, marginBottom: 16 }}>
      <span style={capLabel}>Referral income by level</span>
      <div style={{ overflowX: 'auto', margin: '10px -4px 0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...th, textAlign: 'left' }}>Level</th>
              <th scope="col" style={th}>Bonus each</th>
              <th scope="col" style={th}>People</th>
              <th scope="col" style={th}>Earned</th>
              <th scope="col" style={th}>Paid</th>
              <th scope="col" style={th}>Being paid</th>
              <th scope="col" style={th}>Not payable</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.level}>
                <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 800, color: 'var(--text)' }}>
                  Level {l.level}
                  <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: 'var(--text3)' }}>{whoAt(l.level)}</span>
                </th>
                <td style={td}>{l.reward > 0 ? money(l.reward, 'var(--gold-ink)') : <span style={{ color: 'var(--text3)' }}>Off</span>}</td>
                <td style={{ ...td, fontWeight: 700, color: 'var(--text)' }}>{l.count.toLocaleString('en-IN')}</td>
                <td style={td}>{money(l.confirmed, 'var(--gold-ink)')}</td>
                <td style={td}>{money(l.disbursed, 'var(--green)')}</td>
                <td style={td}>{money(Math.max(0, l.confirmed - l.disbursed), 'var(--gold-ink)')}</td>
                <td style={td}>{money(l.blocked, 'var(--red)')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: 'color-mix(in srgb,var(--gold) 8%,transparent)' }}>
              <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 900, color: 'var(--text)', borderBottom: 'none' }}>Total</th>
              <td style={{ ...td, borderBottom: 'none' }} />
              <td style={{ ...td, fontWeight: 800, color: 'var(--text)', borderBottom: 'none' }}>{total.count.toLocaleString('en-IN')}</td>
              <td style={{ ...td, borderBottom: 'none' }}>{money(total.confirmed, 'var(--gold-ink)')}</td>
              <td style={{ ...td, borderBottom: 'none' }}>{money(total.disbursed, 'var(--green)')}</td>
              <td style={{ ...td, borderBottom: 'none' }}>{money(Math.max(0, total.confirmed - total.disbursed), 'var(--gold-ink)')}</td>
              <td style={{ ...td, borderBottom: 'none' }}>{money(total.blocked, 'var(--red)')}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
};

export default ReferralPage;

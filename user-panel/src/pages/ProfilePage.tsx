// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ProfilePage.tsx — 2026 "Bazaar" redesign.
 *
 * Wired to live GameContext data: profile identity + balances, settled-bet stats
 * (net placed / winnings / win-rate / cycles), KYC status (KYCModal), bank/UPI
 * details (backend.updateBankDetails), theme appearance toggle, and logout.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGame } from '../services/GameContext';
import { useTheme } from '../redesign/ThemeContext';
import { getBackend } from '../services/backend.service';
import { fmt } from '../redesign/format';
import ScreenShell, { card, capLabel, goldButton, inputStyle, fieldLabel } from '../redesign/Screen';
import KYCModal from '../components/Modals/KYCModal';

const backend = getBackend();

const kycMeta: Record<string, { label: string; color: string; bg: string }> = {
  APPROVED:          { label: 'VERIFIED',  color: 'var(--green)', bg: 'color-mix(in srgb,var(--green) 16%,transparent)' },
  PENDING_APPROVAL:  { label: 'IN REVIEW', color: '#FB8C00', bg: 'color-mix(in srgb,#FB8C00 16%,transparent)' },
  REJECTED:          { label: 'REJECTED',  color: 'var(--red)', bg: 'color-mix(in srgb,var(--red) 16%,transparent)' },
  PENDING_SUBMISSION:{ label: 'PENDING',   color: '#FB8C00', bg: 'color-mix(in srgb,#FB8C00 16%,transparent)' },
};

const ProfilePage: React.FC = () => {
  const { user, userBets, updateProfile, logout } = useGame();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [kycOpen, setKycOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localPic, setLocalPic] = useState<string | null>(null);
  const [bank, setBank] = useState({ upiId: '', accountHolderName: '', accountNumber: '', ifscCode: '', bankName: '' });

  const stats = useMemo(() => {
    const settled = (userBets || []).filter(b => b.status === 'WON' || b.status === 'LOST');
    const invested = settled.reduce((a, b) => a + (b.amount || 0), 0);
    const returned = settled.reduce((a, b) => (b.status === 'WON' ? a + (b.payout || b.amount || 0) : a), 0);
    const net = returned - invested;
    const wins = settled.filter(b => b.status === 'WON').length;
    const winRate = settled.length ? Math.round((wins / settled.length) * 100) : 0;
    return [
      { k: 'Net placed bets', v: `₹${fmt(invested)}` },
      { k: 'Net winnings', v: `${net >= 0 ? '+' : '−'}₹${fmt(Math.abs(net))}` },
      { k: 'Win rate', v: `${winRate}%` },
      { k: 'Cycles played', v: fmt(settled.length) },
    ];
  }, [userBets]);

  const initials = (user?.username || 'U').slice(0, 2).toUpperCase();
  const kyc = kycMeta[user?.kycStatus || 'PENDING_SUBMISSION'] || kycMeta.PENDING_SUBMISSION;

  const openBank = () => {
    const d = user?.bankDetails as any;
    setBank({ upiId: d?.upiId || '', accountHolderName: d?.accountHolderName || '', accountNumber: d?.accountNumber || '', ifscCode: d?.ifscCode || '', bankName: d?.bankName || '' });
    setBankOpen(true);
  };

  const saveBank = async () => {
    if (!bank.accountHolderName || !bank.accountNumber || !bank.ifscCode || !bank.bankName) { alert('All bank fields are required.'); return; }
    setSaving(true);
    try {
      await backend.updateBankDetails(user!.id, { accountHolderName: bank.accountHolderName, accountNumber: bank.accountNumber, ifscCode: bank.ifscCode.toUpperCase(), bankName: bank.bankName });
      setBankOpen(false);
      alert('Bank details saved!');
    } catch (e: any) { alert(e?.message || 'Failed to save.'); }
    finally { setSaving(false); }
  };

  const onPicUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > 10 * 1024 * 1024) { alert('Image too large. Max 10MB.'); return; }
    try {
      const reader = new FileReader();
      reader.onloadend = () => setLocalPic(reader.result as string);
      reader.readAsDataURL(file);
      const cdnUrl = await backend.uploadFile(file);
      setLocalPic(cdnUrl);
      await updateProfile({ profilePic: cdnUrl });
    } catch (err: any) { alert(err?.message || 'Upload failed.'); }
  };

  const settingsRows = [
    { ic: '🔔', t: 'Notifications', v: 'On' },
    { ic: '🌐', t: 'Language', v: 'English' },
    { ic: '🔒', t: 'Security & PIN', v: '' },
    { ic: '📄', t: 'Responsible Play', v: '' },
    { ic: 'ℹ️', t: 'About & Terms', v: '' },
  ];

  return (
    <ScreenShell icon="👤" title="Profile" sub="Account, stats & preferences">
      {/* Identity card */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 15, background: 'linear-gradient(135deg,var(--surface2),var(--surface3))', border: '1px solid var(--line2)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-sm)', marginBottom: 14 }}>
        <button onClick={() => fileRef.current?.click()} style={{ width: 62, height: 62, flex: 'none', borderRadius: '50%', overflow: 'hidden', border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {(localPic || user?.profilePic) ? <img src={localPic || user?.profilePic} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 24 }}>{initials}</span>}
          <input type="file" ref={fileRef} accept="image/*" style={{ display: 'none' }} onChange={onPicUpload} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{user?.username || 'Player'}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>ID {user?.id ? String(user.id).slice(-6).toUpperCase() : '—'} · {(user as any)?.mobile ? `+91 ${String((user as any).mobile).slice(0, 5)}•••${String((user as any).mobile).slice(-2)}` : '—'}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6, background: 'color-mix(in srgb,var(--gold) 15%,transparent)', border: '1px solid var(--line2)', borderRadius: 999, padding: '3px 10px' }}><span style={{ fontSize: 11 }}>💎</span><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold-ink)' }}>SILVER TIER</span></div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 14 }}>
        {stats.map(st => (
          <div key={st.k} style={{ ...card, padding: '13px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>{st.k}</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, color: 'var(--text)', marginTop: 2 }}>{st.v}</div>
          </div>
        ))}
      </div>

      {/* KYC */}
      <button onClick={() => setKycOpen(true)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 16, padding: '14px 15px', boxShadow: 'var(--shadow-sm)', marginBottom: 14, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'color-mix(in srgb,var(--gold) 12%,var(--surface3))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🪪</span>
        <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>KYC Verification</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text3)' }}>Aadhaar verification status</span></span>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', padding: '4px 10px', borderRadius: 999, color: kyc.color, background: kyc.bg }}>{kyc.label}</span>
      </button>

      {/* Bank */}
      <button onClick={openBank} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: '14px 15px', boxShadow: 'var(--shadow-sm)', marginBottom: 14, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🏦</span>
        <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Bank / UPI Details</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text3)' }}>{user?.bankDetails?.bankName ? `${user.bankDetails.bankName} ••••${String(user.bankDetails.accountNumber || '').slice(-4)}` : 'Used for sell-order payouts'}</span></span>
        <span style={{ fontSize: 11, color: 'var(--gold-ink)', fontWeight: 800 }}>{user?.bankDetails?.bankName ? 'Edit' : 'Add'}</span>
      </button>

      {/* Settings */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 15px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 17 }}>{theme === 'dark' ? '☀️' : '🌙'}</span><span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Appearance</span>
          <button onClick={toggleTheme} style={{ padding: '6px 13px', borderRadius: 999, border: '1px solid var(--line2)', background: 'var(--surface3)', color: 'var(--gold-ink)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Switch theme</button>
        </div>
        {settingsRows.map(op => (
          <button key={op.t} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 15px', border: 'none', borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ fontSize: 17 }}>{op.ic}</span><span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{op.t}</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{op.v}</span><span style={{ fontSize: 14, color: 'var(--text3)' }}>›</span>
          </button>
        ))}
      </div>

      <button onClick={() => { logout(); navigate('/'); }} style={{ width: '100%', marginTop: 14, padding: 13, borderRadius: 13, border: '1px solid var(--red)', background: 'color-mix(in srgb,var(--red) 10%,transparent)', color: 'var(--red)', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>Log out</button>

      {/* Bank modal */}
      {bankOpen && (
        <div onClick={() => setBankOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 140, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px 16px' }}>
          <div onClick={e => e.stopPropagation()} className="bb-rise" style={{ width: '100%', maxWidth: 420, maxHeight: '92%', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 20, padding: 22, boxShadow: 'var(--shadow)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}><span className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Bank / UPI Details</span><button onClick={() => setBankOpen(false)} style={{ width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>✕</button></div>
            <p style={{ fontSize: 11, color: 'var(--text2)', margin: '0 0 14px' }}>Required to receive sell-order payouts. Stored securely.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              <div><label style={fieldLabel}>UPI ID</label><input value={bank.upiId} onChange={e => setBank({ ...bank, upiId: e.target.value })} placeholder="yourname@okhdfc" style={inputStyle} /></div>
              <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', color: 'var(--text3)' }}>— OR BANK ACCOUNT —</div>
              <div><label style={fieldLabel}>Account holder name</label><input value={bank.accountHolderName} onChange={e => setBank({ ...bank, accountHolderName: e.target.value })} placeholder="Full name as per bank" style={inputStyle} /></div>
              <div><label style={fieldLabel}>Account number</label><input value={bank.accountNumber} onChange={e => setBank({ ...bank, accountNumber: e.target.value })} inputMode="numeric" placeholder="0000 0000 0000" className="font-grotesk" style={inputStyle} /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div><label style={fieldLabel}>IFSC</label><input value={bank.ifscCode} onChange={e => setBank({ ...bank, ifscCode: e.target.value.toUpperCase() })} placeholder="HDFC0001234" style={{ ...inputStyle, textTransform: 'uppercase' }} /></div>
                <div><label style={fieldLabel}>Bank</label><input value={bank.bankName} onChange={e => setBank({ ...bank, bankName: e.target.value })} placeholder="HDFC Bank" style={inputStyle} /></div>
              </div>
              <button onClick={saveBank} disabled={saving} style={{ ...goldButton, opacity: saving ? .6 : 1 }}>{saving ? 'Saving…' : 'Save details'}</button>
            </div>
          </div>
        </div>
      )}

      {kycOpen && <KYCModal onClose={() => setKycOpen(false)} />}
    </ScreenShell>
  );
};

export default ProfilePage;

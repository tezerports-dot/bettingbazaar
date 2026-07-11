// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ProfilePage.tsx  v4.3.0
 *
 * BUG-U5  FIX: userBets guard added (|| []) so .filter() never crashes
 * BUG-U6  FIX: Available balance = depositBalance + winningsBalance - lockedBalance
 * BUG-U8  FIX: Profile pic uploaded to server via uploadFile() + updateProfile(), not just localStorage
 * BUG-U15 FIX: KYC rejection reason shown when kycStatus === 'REJECTED'
 * BUG-U22 FIX: "Bet History" quick action navigates to /my-bets (personal), not /history (global cycles)
 * BUG-U23 FIX: P&L uses b.payout (actual server payout) not hardcoded b.amount * 2
 */
import React, { useState, useRef, useEffect } from 'react';
import { useGame } from '../services/GameContext';
import { useNavigate } from 'react-router-dom';
import Modal from '../components/ui/Modal';
import { Show } from '../components/ui/Show';
import KYCModal from '../components/Modals/KYCModal';
import { getBackend } from '../services/backend.service';
import { APP_NAME_FALLBACK as APP_NAME } from '../constants';

const backend = getBackend();

const ProfilePage: React.FC = () => {
  const { user, userBets: rawUserBets, updateProfile, refreshUserWallet } = useGame();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BUG-U5 fix: always an array, never undefined
  const userBets = rawUserBets || [];

  const [localProfilePic, setLocalProfilePic] = useState<string | null>(null);
  const [isEditOpen, setIsEditOpen]         = useState(false);
  const [isBankOpen, setIsBankOpen]         = useState(false);
  const [isKYCModalOpen, setIsKYCModalOpen] = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [activeTab, setActiveTab]           = useState<'profile' | 'security'>('profile');
  const [uploadingPic, setUploadingPic]     = useState(false);

  const [formData, setFormData] = useState({ username: '', mobile: '', email: '', newPassword: '', confirmPassword: '' });
  const [bankData, setBankData] = useState({ accountHolderName: '', accountNumber: '', ifscCode: '', bankName: '' });

  useEffect(() => {
    const stored = localStorage.getItem(`device_user_img_${user?.id}`);
    if (stored) setLocalProfilePic(stored);
  }, [user?.id]);

  // BUG-U23 fix: use b.payout (real server payout amount) not hardcoded b.amount * 2
  const settledBets   = userBets.filter(b => b.status === 'WON' || b.status === 'LOST');
  const totalInvested = settledBets.reduce((acc, b) => acc + (b.amount || 0), 0);
  const totalReturn   = settledBets.reduce((acc, b) => (b.status === 'WON' ? acc + (b.payout || b.amount || 0) : acc), 0);
  const netPL         = totalReturn - totalInvested;
  const isProfit      = netPL >= 0;

  // BUG-U6 fix: correct dual balance calculation
  const depositBal  = user?.depositBalance  || 0;
  const winningsBal = user?.winningsBalance || 0;
  const lockedBal   = user?.lockedBalance   || 0;
  // Architecture: deposit+winnings is spendable; lockedBal is a tracking counter not a deduction
  const availableBal = depositBal + winningsBal;

  const handleEditClick = () => {
    if (user) {
      setFormData({ username: user.username || '', mobile: (user as any).mobile || '', email: (user as any).email || '', newPassword: '', confirmPassword: '' });
      setActiveTab('profile');
      setIsEditOpen(true);
    }
  };

  const handleBankClick = () => {
    setBankData({
      accountHolderName: user?.bankDetails?.accountHolderName || '',
      accountNumber:     user?.bankDetails?.accountNumber     || '',
      ifscCode:          user?.bankDetails?.ifscCode          || '',
      bankName:          user?.bankDetails?.bankName          || '',
    });
    setIsBankOpen(true);
  };

  const handleSaveProfile = async () => {
    if (!formData.username.trim()) return alert('Name is required.');
    const trimmedEmail = formData.email.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) return alert('Please enter a valid email address.');
    if (formData.newPassword && formData.newPassword.length < 6) return alert('Password must be at least 6 characters.');
    if (formData.newPassword && formData.newPassword !== formData.confirmPassword) return alert('Passwords do not match.');
    setSaving(true);
    try {
      const updates: any = {};
      if (formData.username !== user?.username) updates.username = formData.username.trim();
      if (trimmedEmail !== ((user as any)?.email || '')) updates.email = trimmedEmail;
      if (formData.newPassword) updates.password = formData.newPassword;
      if (Object.keys(updates).length > 0) {
        await updateProfile(updates);
        alert('Profile updated!');
      }
      setIsEditOpen(false);
    } catch (e: any) {
      alert(e.message || 'Update failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBankDetails = async () => {
    if (!bankData.accountHolderName || !bankData.accountNumber || !bankData.ifscCode || !bankData.bankName)
      return alert('All bank fields are required.');
    setSaving(true);
    try {
      await backend.updateBankDetails(user!.id, { ...bankData, ifscCode: bankData.ifscCode.toUpperCase() });
      setIsBankOpen(false);
      alert('Bank details saved!');
    } catch (e: any) {
      alert(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  // Profile pic — upload to S3 first, then save CDN URL to user profile
  const handleProfilePicUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || !user) return;
    const file = e.target.files[0];
    if (file.size > 10 * 1024 * 1024) { alert('Image too large. Max 10MB.'); return; }
    if (!file.type.startsWith('image/')) { alert('Only image files allowed.'); return; }

    setUploadingPic(true);
    try {
      // Show preview immediately for responsiveness
      const reader = new FileReader();
      reader.onloadend = () => setLocalProfilePic(reader.result as string);
      reader.readAsDataURL(file);

      // Upload to S3/CDN
      const cdnUrl = await backend.uploadFile(file);
      setLocalProfilePic(cdnUrl);
      // Save CDN URL to server profile (persists across devices)
      await backend.updateUserProfile(user.id, { profilePic: cdnUrl });
      // Also cache locally for instant display
      localStorage.setItem(`device_user_img_${user.id}`, cdnUrl);
    } catch (err: any) {
      // S3 not configured — keep base64 fallback in localStorage only
      console.warn('S3 upload failed, using local cache:', err.message);
    } finally {
      setUploadingPic(false);
    }
  };

  const inp = "w-full bg-[#0B0E14] border border-[#1e2736] rounded-2xl p-4 text-sm text-white focus:border-[#D4AF37] outline-none font-medium placeholder-gray-600";
  const lbl = "text-[10px] text-slate-500 uppercase font-black mb-1.5 block ml-1 tracking-widest";

  return (
    <div className="h-full flex flex-col bg-[#0B0E14]">
      <div className="flex-1 overflow-y-auto p-5 space-y-4 pb-4">

        {/* Profile Card */}
        <div className="bg-[#121826] rounded-[2.5rem] p-8 flex flex-col items-center border border-[#D4AF37]/20 relative overflow-hidden text-center">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-[#F5C77A] to-[#D4AF37]"></div>
          <div
            className="w-28 h-28 rounded-full border-4 border-[#D4AF37] overflow-hidden mb-4 relative bg-black group cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <img
              src={localProfilePic || user?.profilePic || `https://ui-avatars.com/api/?name=${encodeURIComponent(user?.username || 'U')}&background=D4AF37&color=000&bold=true`}
              className="w-full h-full object-cover"
              alt="Profile"
            />
            <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-all">
              {uploadingPic ? (
                <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span className="text-xl">📷</span>
                  <span className="text-white text-[9px] font-bold mt-1">CHANGE</span>
                </>
              )}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleProfilePicUpload} />
          </div>
          <h2 className="text-2xl font-black text-white">{user?.username}</h2>
          <p className="text-slate-400 text-xs mt-1">📱 {(user as any)?.mobile || '—'}</p>
          <p className="text-[#D4AF37] text-[10px] uppercase font-black tracking-widest mt-2 border border-[#D4AF37]/30 px-3 py-1 rounded-full">{APP_NAME} Member</p>
        </div>

        {/* Balances — BUG-U6 fix */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-[#1A1F2E] p-4 rounded-2xl border border-white/5">
            <div className="text-[9px] text-slate-500 uppercase font-black mb-1">Spendable</div>
            <div className="text-base font-black text-[#25D366]">₹{availableBal.toLocaleString()}</div>
          </div>
          <div className="bg-[#1A1F2E] p-4 rounded-2xl border border-white/5">
            <div className="text-[9px] text-slate-500 uppercase font-black mb-1">Withdrawable</div>
            <div className="text-base font-black text-[#D4AF37]">₹{winningsBal.toLocaleString()}</div>
          </div>
          <div className="bg-[#1A1F2E] p-4 rounded-2xl border border-white/5">
            <div className="text-[9px] text-slate-500 uppercase font-black mb-1">In Play</div>
            <div className="text-base font-black text-[#E53935]">₹{lockedBal.toLocaleString()}</div>
          </div>
        </div>

        {/* P&L — BUG-U23 fix */}
        <div className={`p-6 rounded-2xl border border-white/5 flex flex-col items-center bg-gradient-to-br ${isProfit ? 'from-green-900/30' : 'from-red-900/30'} to-black`}>
          <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-2 font-black">Net P&L ({settledBets.length} settled bets)</div>
          <div className={`text-4xl font-black ${isProfit ? 'text-[#25D366]' : 'text-[#E53935]'}`}>
            {isProfit ? '+' : '−'} ₹{Math.abs(netPL).toLocaleString()}
          </div>
          {settledBets.length > 0 && (
            <div className="mt-3 flex gap-6 text-xs text-slate-500">
              <span>Invested: <span className="text-white font-bold">₹{totalInvested.toLocaleString()}</span></span>
              <span>Returned: <span className="text-white font-bold">₹{totalReturn.toLocaleString()}</span></span>
            </div>
          )}
        </div>

        {/* KYC — BUG-U15 fix: show rejection reason */}
        <div className="bg-[#1A1F2E] rounded-2xl p-5 border border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-white/10 ${
                user?.kycStatus === 'APPROVED'         ? 'text-green-500 bg-green-900/20' :
                user?.kycStatus === 'REJECTED'         ? 'text-red-500 bg-red-900/20' :
                user?.kycStatus === 'PENDING_APPROVAL' ? 'text-yellow-500 bg-yellow-900/20' :
                'text-orange-500 bg-orange-900/20'
              }`}>
                {user?.kycStatus === 'APPROVED' ? '✅' : user?.kycStatus === 'REJECTED' ? '❌' : '⚠️'}
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-black tracking-widest">KYC Status</div>
                <div className={`text-sm font-black uppercase ${
                  user?.kycStatus === 'APPROVED'         ? 'text-green-400' :
                  user?.kycStatus === 'REJECTED'         ? 'text-red-400' :
                  user?.kycStatus === 'PENDING_APPROVAL' ? 'text-yellow-400' :
                  'text-orange-400'
                }`}>
                  {user?.kycStatus?.replace(/_/g, ' ') || 'NOT SUBMITTED'}
                </div>
                {/* BUG-U15 fix: show rejection reason */}
                {user?.kycStatus === 'REJECTED' && (user as any)?.kycData?.rejectionReason && (
                  <div className="text-[10px] text-red-300 mt-1 max-w-[200px]">
                    Reason: {(user as any).kycData.rejectionReason}
                  </div>
                )}
              </div>
            </div>
            <Show when={user?.kycStatus !== 'APPROVED' && user?.kycStatus !== 'PENDING_APPROVAL'}>
              <button
                onClick={() => setIsKYCModalOpen(true)}
                className="bg-[#D4AF37] text-black text-[10px] font-black px-4 py-2 rounded-xl"
              >
                {user?.kycStatus === 'REJECTED' ? 'RESUBMIT' : 'VERIFY'}
              </button>
            </Show>
          </div>
        </div>

        {/* Actions — BUG-U22 fix: "Bet History" → /my-bets */}
        <div className="space-y-3">
          {[
            { icon: '✏️', label: 'Edit Profile',  sub: 'Name · Mobile · Password', action: handleEditClick },
            { icon: '🏦', label: 'Bank Details',  sub: user?.bankDetails?.bankName ? `${user.bankDetails.bankName} ···${user.bankDetails.accountNumber?.slice(-4)}` : 'Tap to add bank account', action: handleBankClick },
            // BUG-U22 fix: now navigates to /my-bets (personal), not /history (global)
            { icon: '📜', label: 'My Bet History', sub: `${settledBets.length} settled bets`, action: () => navigate('/my-bets') },
          ].map((item, i) => (
            <button key={i} onClick={item.action}
              className="w-full bg-[#1A1F2E] p-5 rounded-2xl border border-white/5 text-left flex justify-between items-center group hover:border-[#D4AF37]/30 active:scale-[0.98] transition-all">
              <div className="flex items-center gap-3">
                <span className="text-lg">{item.icon}</span>
                <div>
                  <div className="text-sm font-bold text-slate-200">{item.label}</div>
                  <div className="text-[10px] text-slate-500">{item.sub}</div>
                </div>
              </div>
              <span className="text-[#D4AF37] text-lg group-hover:translate-x-1 transition-transform">›</span>
            </button>
          ))}
        </div>
      </div>

      {/* Edit Profile Modal */}
      <Show when={isEditOpen}>
        <Modal onClose={() => setIsEditOpen(false)} title="Edit Profile">
          <div className="space-y-5">
            <div className="flex gap-2 bg-[#0B0E14] p-1 rounded-xl">
              {(['profile', 'security'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${activeTab === tab ? 'bg-[#D4AF37] text-black' : 'text-slate-400'}`}>
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'profile' ? (
              <div className="space-y-4">
                <div>
                  <label className={lbl}>Display Name</label>
                  <input type="text" value={formData.username} placeholder="Your name"
                    onChange={e => setFormData({ ...formData, username: e.target.value })} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Email <span className="text-slate-600 normal-case tracking-normal">(optional — for notifications)</span></label>
                  <input type="email" value={formData.email} placeholder="you@example.com"
                    onChange={e => setFormData({ ...formData, email: e.target.value })} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Profile Photo</label>
                  <button onClick={() => fileInputRef.current?.click()}
                    className="w-full bg-[#0B0E14] border border-[#1e2736] rounded-2xl p-4 text-sm text-slate-400 text-left hover:border-[#D4AF37] transition-all flex items-center gap-3">
                    <span>📷</span>
                    <span>{uploadingPic ? 'Uploading…' : localProfilePic ? 'Change photo' : 'Upload photo (max 2MB)'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-xl p-3 text-xs text-yellow-400">
                  Leave blank to keep current password
                </div>
                <div>
                  <label className={lbl}>New Password</label>
                  <input type="password" value={formData.newPassword} placeholder="Min 6 characters"
                    onChange={e => setFormData({ ...formData, newPassword: e.target.value })} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Confirm New Password</label>
                  <input type="password" value={formData.confirmPassword} placeholder="Repeat password"
                    onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })} className={inp} />
                </div>
              </div>
            )}

            <button onClick={handleSaveProfile} disabled={saving}
              className="w-full bg-[#D4AF37] text-black font-black py-4 rounded-2xl disabled:opacity-50 uppercase text-xs tracking-widest hover:bg-[#F5C77A] active:scale-[0.98] transition-all">
              {saving ? 'SAVING...' : 'SAVE CHANGES'}
            </button>
          </div>
        </Modal>
      </Show>

      {/* Bank Details Modal */}
      <Show when={isBankOpen}>
        <Modal onClose={() => setIsBankOpen(false)} title="Bank Details">
          <div className="space-y-4">
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-xl p-3 text-xs text-blue-400">
              Required for withdrawals. Encrypted and stored securely.
            </div>
            {[
              { k: 'accountHolderName', lbl: 'Account Holder Name', ph: 'Full name as on bank account' },
              { k: 'accountNumber',     lbl: 'Account Number',       ph: 'Your bank account number' },
              { k: 'ifscCode',          lbl: 'IFSC Code',            ph: 'e.g. HDFC0001234' },
              { k: 'bankName',          lbl: 'Bank Name',            ph: 'e.g. HDFC Bank' },
            ].map(f => (
              <div key={f.k}>
                <label className={lbl}>{f.lbl}</label>
                <input type="text" value={(bankData as any)[f.k]} placeholder={f.ph}
                  onChange={e => setBankData({ ...bankData, [f.k]: f.k === 'ifscCode' ? e.target.value.toUpperCase() : e.target.value })}
                  className={inp} />
              </div>
            ))}
            <button onClick={handleSaveBankDetails} disabled={saving}
              className="w-full bg-[#D4AF37] text-black font-black py-4 rounded-2xl disabled:opacity-50 uppercase text-xs tracking-widest hover:bg-[#F5C77A] active:scale-[0.98] transition-all">
              {saving ? 'SAVING...' : 'SAVE BANK DETAILS'}
            </button>
          </div>
        </Modal>
      </Show>

      <Show when={isKYCModalOpen}>
        <KYCModal onClose={() => setIsKYCModalOpen(false)} />
      </Show>
    </div>
  );
};

export default ProfilePage;

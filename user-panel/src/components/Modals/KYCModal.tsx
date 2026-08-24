// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYCModal.tsx — 2026 "Bazaar" redesign. Identity verification (Aadhaar + selfie).
 * Presigned-upload logic and backend.uploadKYC submission are unchanged; only the
 * presentation is rebuilt on the redesign theme tokens.
 */
import React, { useState } from 'react';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';
import { apiClient } from '../../services/apiClient';

const backend = getBackend();
interface KYCModalProps { onClose: () => void; }

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 5 };
const inputStyle: React.CSSProperties = { width: '100%', height: 44, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 11, padding: '0 13px', color: 'var(--text)', fontSize: 13, outline: 'none' };

const KYCModal: React.FC<KYCModalProps> = ({ onClose }) => {
  const { user } = useGame();
  const [kycData, setKycData] = useState({ nameOnAadhaar: '', aadhaarNumber: '' });
  const [files, setFiles] = useState<{ idProof: File | null; photo: File | null }>({ idProof: null, photo: null });
  const [uploadProgress, setUploadProgress] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (type: 'idProof' | 'photo', e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) { alert('File size must be less than 5MB'); return; }
      if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) { alert('Only JPG, PNG, or PDF files allowed'); return; }
      setFiles(prev => ({ ...prev, [type]: file }));
    }
  };

  const submitKYC = async () => {
    setError('');
    if (!kycData.nameOnAadhaar.trim()) return setError('Please enter your name as on Aadhaar card');
    if (!kycData.aadhaarNumber.trim() || !/^\d{12}$/.test(kycData.aadhaarNumber)) return setError('Please enter a valid 12-digit Aadhaar number');
    if (!files.idProof) return setError('Please upload your Aadhaar card image');
    if (!files.photo) return setError('Please upload your selfie');
    if (!user) return setError('Not logged in');

    setIsProcessing(true); setUploadProgress('uploading');
    try {
      // The document goes to a PRIVATE bucket and the response carries a key,
      // not a URL. There is no public address for an Aadhaar card to hand back,
      // and nothing here should hold one: the key is a reference, and viewing
      // the document later is a decision an authenticated reviewer makes.
      const uploadKycFile = async (docType: 'id-proof' | 'selfie', file: File) => {
        // `/api/user/...`, NOT `/api/upload/user/...` — routes/upload.routes.js is
        // mounted at `/api` (server.js), so its own paths already begin `/user/`.
        // The extra segment was here until 2026-08-24 and made every KYC document
        // upload 404 before the file was ever read.
        const urlRes: any = await apiClient.post(`/api/user/kyc/${docType}/upload-url`, { fileName: file.name, contentType: file.type, fileSize: file.size });
        if (!urlRes.uploadUrl || !urlRes.key) throw new Error('Upload response missing file key');
        const put = await fetch(urlRes.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
        // The grant pins content type and length, so a mismatch is rejected by
        // storage. Failing here rather than submitting a key to an object that
        // was never written is what stops a reviewer seeing a broken tile they
        // cannot distinguish from a storage fault.
        if (!put.ok) throw new Error('Upload failed. Please check your connection and try again.');
        return { key: urlRes.key };
      };
      const [idProof, photo] = await Promise.all([uploadKycFile('id-proof', files.idProof), uploadKycFile('selfie', files.photo)]);
      setUploadProgress('done');
      await backend.uploadKYC(user.id, {
        nameOnAadhaar: kycData.nameOnAadhaar.trim().toUpperCase(), aadhaarNumber: kycData.aadhaarNumber.trim(),
        idProofKey: idProof.key, photoKey: photo.key,
      });
      alert('✅ KYC Documents Submitted Successfully.\n\nOur compliance team will review your application within 24 hours.');
      onClose();
    } catch (e: any) { setUploadProgress('idle'); setError(e.message || 'Submission failed. Please try again.'); }
    finally { setIsProcessing(false); }
  };

  const uploadTile = (type: 'idProof' | 'photo', icon: string, label: string, formats: string) => {
    const has = !!files[type];
    return (
      <label style={{ border: `2px dashed ${has ? 'var(--green)' : 'var(--line2)'}`, borderRadius: 12, padding: '16px 8px', textAlign: 'center', background: has ? 'color-mix(in srgb,var(--green) 10%,transparent)' : 'var(--surface2)', cursor: 'pointer', display: 'block' }}>
        {/* Images only, and specifically these three. The private store refuses
            PDFs and SVGs; offering `.pdf` in the picker only produced a file the
            server would reject after the user had already waited for it. */}
        <input type="file" style={{ display: 'none' }} accept="image/jpeg,image/png,image/webp" onChange={e => handleFileChange(type, e)} />
        <div style={{ fontSize: 22 }}>{has ? '✅' : icon}</div>
        <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', color: has ? 'var(--green)' : 'var(--text2)', marginTop: 4 }}>{has ? (files[type]!.name.slice(0, 14) + '…') : label}</div>
        <div style={{ fontSize: 8, color: 'var(--text3)' }}>{formats}</div>
      </label>
    );
  };

  const canSubmit = !isProcessing && files.idProof && files.photo && kycData.nameOnAadhaar && kycData.aadhaarNumber;

  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 140, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px 16px' }}>
      <div onClick={e => e.stopPropagation()} className="bb-rise" style={{ width: '100%', maxWidth: 420, maxHeight: '92%', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 20, padding: 22, boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Identity Verification</span>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>✕</button>
        </div>
        <p style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--text2)', margin: '0 0 14px' }}><b style={{ color: 'var(--gold-ink)' }}>Required for withdrawals.</b> Verify your identity to unlock selling tokens. Data is encrypted and stored securely.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <div><label style={labelStyle}>Mobile number</label><input value={(user as any)?.mobile || ''} disabled className="font-grotesk" style={{ ...inputStyle, background: 'var(--surface3)', color: 'var(--text3)' }} /></div>
          <div><label style={labelStyle}>Name on Aadhaar <span style={{ color: 'var(--red)' }}>*</span></label><input value={kycData.nameOnAadhaar} onChange={e => setKycData({ ...kycData, nameOnAadhaar: e.target.value.toUpperCase() })} placeholder="e.g. RAHUL SHARMA" style={{ ...inputStyle, textTransform: 'uppercase' }} /></div>
          <div><label style={labelStyle}>Aadhaar number <span style={{ color: 'var(--red)' }}>*</span></label><input value={kycData.aadhaarNumber} onChange={e => setKycData({ ...kycData, aadhaarNumber: e.target.value.replace(/\D/g, '').slice(0, 12) })} inputMode="numeric" placeholder="1234 5678 9012" className="font-grotesk" style={{ ...inputStyle, letterSpacing: '.12em' }} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {uploadTile('idProof', '📄', 'Aadhaar Front', 'JPG · PNG · WEBP')}
            {uploadTile('photo', '🤳', 'Selfie', 'JPG · PNG')}
          </div>

          {uploadProgress === 'uploading' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--gold-ink)', background: 'color-mix(in srgb,var(--gold) 10%,transparent)', padding: 12, borderRadius: 11, border: '1px solid var(--line2)' }}>
              <span className="bb-spin" style={{ width: 16, height: 16, border: '2px solid var(--line2)', borderTopColor: 'var(--gold)', borderRadius: '50%', flex: 'none' }} />Encrypting & uploading documents…
            </div>
          )}

          <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 10, padding: 8, textAlign: 'center' }}><span style={{ fontSize: 9, color: 'var(--text3)' }}>Max 5MB per file · encrypted on upload</span></div>
          {error && <div style={{ fontSize: 11, fontWeight: 700, textAlign: 'center', color: 'var(--red)', background: 'color-mix(in srgb,var(--red) 12%,transparent)', padding: 8, borderRadius: 10, border: '1px solid color-mix(in srgb,var(--red) 30%,transparent)' }}>{error}</div>}

          <button onClick={submitKYC} disabled={!canSubmit} style={{ width: '100%', padding: 13, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 14, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', opacity: canSubmit ? 1 : .5 }}>{isProcessing ? 'Uploading & Submitting…' : 'Submit Verification'}</button>
        </div>
      </div>
    </div>
  );
};

export default KYCModal;

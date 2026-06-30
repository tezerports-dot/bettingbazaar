// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYCModal.tsx  v4.3.0
 * BUG-U7 FIX: Uploads files to /content/upload FIRST to get real URLs,
 * then submits those URLs to /user/:id/kyc.
 * Previously hardcoded placeholder strings were sent → backend now rejects them.
 */
import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';
import { Show } from '../ui/Show';

const backend = getBackend();

interface KYCModalProps {
  onClose: () => void;
}

const KYCModal: React.FC<KYCModalProps> = ({ onClose }) => {
  const { user } = useGame();
  const [kycData, setKycData] = useState({ nameOnPAN: '', panNumber: '' });
  const [files, setFiles] = useState<{ idProof: File | null, photo: File | null }>({ idProof: null, photo: null });
  const [uploadProgress, setUploadProgress] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (type: 'idProof' | 'photo', e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) { alert('File size must be less than 5MB'); return; }
      if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
        alert('Only JPG, PNG, or PDF files allowed'); return;
      }
      setFiles(prev => ({ ...prev, [type]: file }));
    }
  };

  const submitKYC = async () => {
    setError('');
    if (!kycData.nameOnPAN.trim()) return setError('Please enter your name as on PAN card');
    if (!kycData.panNumber.trim() || !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(kycData.panNumber))
      return setError('Please enter a valid PAN number (e.g. ABCDE1234F)');
    if (!files.idProof) return setError('Please upload your PAN card image');
    if (!files.photo) return setError('Please upload your selfie');
    if (!user) return setError('Not logged in');

    setIsProcessing(true);
    setUploadProgress('uploading');

    try {
      // BUG-U7 FIX: Upload files FIRST to get real CDN URLs
      const [idProofUrl, photoUrl] = await Promise.all([
        backend.uploadFile(files.idProof),
        backend.uploadFile(files.photo)
      ]);

      if (!idProofUrl || !photoUrl) {
        throw new Error('File upload failed — please try again');
      }

      setUploadProgress('done');

      // Now submit with real URLs (not placeholder strings)
      await backend.uploadKYC(user.id, {
        nameOnPAN: kycData.nameOnPAN.trim().toUpperCase(),
        panNumber: kycData.panNumber.trim().toUpperCase(),
        idProofUrl,
        photoUrl
      });

      alert('✅ KYC Documents Submitted Successfully.\n\nOur compliance team will review your application within 24 hours.');
      onClose();
    } catch (e: any) {
      setUploadProgress('idle');
      setError(e.message || 'Submission failed. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const inp = 'w-full bg-[#0F172A] border border-slate-600 rounded p-3 text-white mt-1 text-sm focus:border-[#D4AF37] outline-none';

  return (
    <Modal onClose={onClose} title="Identity Verification">
      <div className="space-y-4">
        <p className="text-slate-400 text-xs">
          <span className="text-[#D4AF37] font-bold">Important:</span> Verify your identity to unlock withdrawals. Data is encrypted and stored securely.
        </p>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase">Mobile Number</label>
          <input
            type="text"
            value={user?.mobile || ''}
            disabled
            className="w-full bg-[#0B0E14] border border-slate-700 rounded p-3 text-slate-500 mt-1 text-sm font-mono cursor-not-allowed"
          />
        </div>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase">Name on PAN Card <span className="text-red-500">*</span></label>
          <input
            type="text"
            placeholder="e.g. RAHUL SHARMA"
            value={kycData.nameOnPAN}
            onChange={e => setKycData({ ...kycData, nameOnPAN: e.target.value.toUpperCase() })}
            className={inp}
          />
        </div>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase">PAN Number <span className="text-red-500">*</span></label>
          <input
            type="text"
            placeholder="ABCDE1234F"
            maxLength={10}
            value={kycData.panNumber}
            onChange={e => {
              // PAN format: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F)
              const raw = e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
              setKycData({ ...kycData, panNumber: raw });
            }}
            className={`${inp} font-mono tracking-widest`}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 mt-2">
          {/* ID Proof Upload */}
          <label className={`border border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors group relative ${files.idProof ? 'border-green-500 bg-green-900/10' : 'border-slate-600 hover:bg-white/5'}`}>
            <input type="file" className="hidden" accept="image/*,.pdf" onChange={(e) => handleFileChange('idProof', e)} />
            <span className="text-2xl block mb-1">{files.idProof ? '✅' : '📄'}</span>
            <span className={`text-[10px] font-bold uppercase block ${files.idProof ? 'text-green-400' : 'text-slate-400'}`}>
              {files.idProof ? files.idProof.name.substring(0, 14) + '…' : 'PAN Card Front'}
            </span>
            <span className="text-[9px] text-slate-600 block mt-0.5">JPG / PNG / PDF</span>
          </label>

          {/* Selfie Upload */}
          <label className={`border border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors group relative ${files.photo ? 'border-green-500 bg-green-900/10' : 'border-slate-600 hover:bg-white/5'}`}>
            <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileChange('photo', e)} />
            <span className="text-2xl block mb-1">{files.photo ? '✅' : '🤳'}</span>
            <span className={`text-[10px] font-bold uppercase block ${files.photo ? 'text-green-400' : 'text-slate-400'}`}>
              {files.photo ? files.photo.name.substring(0, 14) + '…' : 'Upload Selfie'}
            </span>
            <span className="text-[9px] text-slate-600 block mt-0.5">JPG / PNG only</span>
          </label>
        </div>

        {/* Upload progress indicator */}
        {uploadProgress === 'uploading' && (
          <div className="flex items-center gap-2 text-xs text-[#D4AF37] bg-[#D4AF37]/10 p-3 rounded-lg border border-[#D4AF37]/30">
            <div className="w-4 h-4 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin flex-shrink-0" />
            Encrypting & uploading documents…
          </div>
        )}

        <div className="bg-[#121826] p-2 rounded border border-white/5">
          <p className="text-[9px] text-slate-500 text-center">
            Max 5MB per file. Formats: JPG, PNG, PDF. Files are encrypted on upload.
          </p>
        </div>

        <Show when={error !== ''}>
          <div className="text-red-400 text-xs font-bold text-center bg-red-900/20 p-2 rounded border border-red-500/30">{error}</div>
        </Show>

        <button
          onClick={submitKYC}
          disabled={isProcessing || !files.idProof || !files.photo || !kycData.nameOnPAN || !kycData.panNumber}
          className="w-full bg-[#D4AF37] hover:bg-[#B8860B] text-black font-bold py-3 rounded-xl transition-all disabled:opacity-50 active:scale-95 shadow-lg mt-2"
        >
          {isProcessing ? 'Uploading & Submitting…' : 'Submit Verification'}
        </button>
      </div>
    </Modal>
  );
};

export default KYCModal;

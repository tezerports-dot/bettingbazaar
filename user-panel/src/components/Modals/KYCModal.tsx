// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYCModal.tsx  v4.3.0
 * KYC files use presigned uploads and submit file keys.
 * The backend verifies object existence/ownership before storing CDN URLs.
 */
import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';
import { Show } from '../ui/Show';
import { apiClient } from '../../services/apiClient';

const backend = getBackend();

interface KYCModalProps {
  onClose: () => void;
}

const KYCModal: React.FC<KYCModalProps> = ({ onClose }) => {
  const { user } = useGame();
  const [kycData, setKycData] = useState({ nameOnAadhaar: '', aadhaarNumber: '' });
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
    if (!kycData.nameOnAadhaar.trim()) return setError('Please enter your name as on Aadhaar card');
    if (!kycData.aadhaarNumber.trim() || !/^\d{12}$/.test(kycData.aadhaarNumber))
      return setError('Please enter a valid 12-digit Aadhaar number');
    if (!files.idProof) return setError('Please upload your Aadhaar card image');
    if (!files.photo) return setError('Please upload your selfie');
    if (!user) return setError('Not logged in');

    setIsProcessing(true);
    setUploadProgress('uploading');

    try {
      const uploadKycFile = async (docType: 'id-proof' | 'selfie', file: File) => {
        const urlRes: any = await apiClient.post(`/api/upload/user/kyc/${docType}/upload-url`, {
          fileName: file.name, contentType: file.type, fileSize: file.size,
        });
        await fetch(urlRes.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
        if (!urlRes.fileKey || !urlRes.cdnUrl) throw new Error('Upload response missing file key');
        return { fileKey: urlRes.fileKey, cdnUrl: urlRes.cdnUrl };
      };

      const [idProof, photo] = await Promise.all([
        uploadKycFile('id-proof', files.idProof),
        uploadKycFile('selfie', files.photo),
      ]);

      setUploadProgress('done');

      await backend.uploadKYC(user.id, {
        nameOnAadhaar: kycData.nameOnAadhaar.trim().toUpperCase(),
        aadhaarNumber: kycData.aadhaarNumber.trim(),
        idProofKey: idProof.fileKey,
        idProofCdnUrl: idProof.cdnUrl,
        photoKey: photo.fileKey,
        photoCdnUrl: photo.cdnUrl,
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
          <label className="text-xs font-bold text-slate-400 uppercase">Name on Aadhaar Card <span className="text-red-500">*</span></label>
          <input
            type="text"
            placeholder="e.g. RAHUL SHARMA"
            value={kycData.nameOnAadhaar}
            onChange={e => setKycData({ ...kycData, nameOnAadhaar: e.target.value.toUpperCase() })}
            className={inp}
          />
        </div>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase">Aadhaar Number <span className="text-red-500">*</span></label>
          <input
            type="text"
            placeholder="123456789012"
            maxLength={12}
            value={kycData.aadhaarNumber}
            onChange={e => {
              // Aadhaar format: 12 digits
              const raw = e.target.value.replace(/\D/g, '').slice(0, 12);
              setKycData({ ...kycData, aadhaarNumber: raw });
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
              {files.idProof ? files.idProof.name.substring(0, 14) + '…' : 'Aadhaar Card Front'}
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
          disabled={isProcessing || !files.idProof || !files.photo || !kycData.nameOnAadhaar || !kycData.aadhaarNumber}
          className="w-full bg-[#D4AF37] hover:bg-[#B8860B] text-black font-bold py-3 rounded-xl transition-all disabled:opacity-50 active:scale-95 shadow-lg mt-2"
        >
          {isProcessing ? 'Uploading & Submitting…' : 'Submit Verification'}
        </button>
      </div>
    </Modal>
  );
};

export default KYCModal;

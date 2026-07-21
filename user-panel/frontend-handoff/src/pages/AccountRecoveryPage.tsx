// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AccountRecoveryPage.tsx
 *
 * User-facing Aadhaar card video KYC account recovery.
 * Flow:
 *  1. User enters their Aadhaar number → system finds the locked/lost account
 *  2. User records a short video HOLDING their Aadhaar card clearly in frame
 *  3. User fills their name (as on Aadhaar) and DOB (as on Aadhaar) + contact mobile
 *  4. Admin reviews the video — verifies face and Aadhaar card details match
 *  5. If approved, admin gets a temp password to share with user
 */
import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router';

type Step = 'aadhaar_check' | 'record_video' | 'details' | 'submitted';

export default function AccountRecoveryPage() {
  const navigate = useNavigate();
  const [step, setStep]           = useState<Step>('aadhaar_check');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [checking, setChecking]   = useState(false);
  const [aadhaarError, setAadhaarError]   = useState('');
  const [videoBlob, setVideoBlob] = useState<Blob|null>(null);
  const [videoUrl, setVideoUrl]   = useState('');
  const [videoS3Url, setVideoS3Url] = useState('');
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm]           = useState({ fullName:'', dob:'', mobile:'' });
  const [submitting, setSubmitting] = useState(false);
  const [recoveryId, setRecoveryId] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const mediaRef  = useRef<MediaRecorder|null>(null);
  const streamRef = useRef<MediaStream|null>(null);
  const videoElRef= useRef<HTMLVideoElement>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ── Step 1: Check Aadhaar ────────────────────────────────────────────────────
  const checkAadhaar = async () => {
    const clean = aadhaarNumber.replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(clean)) {
      setAadhaarError('Invalid Aadhaar format. Enter 12 digits.'); return;
    }
    setChecking(true); setAadhaarError('');
    try {
      const r = await fetch('/api/auth/check-aadhaar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ aadhaarNumber: clean }),
      });
      const d = await r.json();
      if (d.success) {
        // Always proceed to video step - account existence is verified during admin review
        setStep('record_video');
      } else {
        setAadhaarError(d.message || 'Unable to process request. Please try again.');
      }
    } catch { setAadhaarError('Network error. Please try again.'); }
    finally { setChecking(false); }
  };

  // ── Step 2: Record video ─────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoElRef.current) { videoElRef.current.srcObject = stream; videoElRef.current.play(); }
      chunksRef.current = [];
      const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        setVideoBlob(blob);
        setVideoUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        if (videoElRef.current) videoElRef.current.srcObject = null;
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch { alert('Camera/microphone access is required for video KYC.'); }
  };

  const stopRecording = () => {
    mediaRef.current?.stop();
    setRecording(false);
  };

  const uploadVideo = async () => {
    if (!videoBlob) return;
    setUploading(true);
    try {
      // Get presigned URL
      const r1 = await fetch('/api/user/kyc/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ fileName:'recovery_video.webm', contentType:'video/webm', fileSize:videoBlob.size, docType:'recovery_video' }),
      });
      const u = await r1.json();
      if (!u.success) throw new Error(u.message);
      // Upload to S3
      await fetch(u.uploadUrl, { method:'PUT', body:videoBlob, headers:{'Content-Type':'video/webm'} });
      setVideoS3Url(u.cdnUrl);
      setStep('details');
    } catch (e: any) { alert('Upload failed: ' + e.message); }
    finally { setUploading(false); }
  };

  const retakeVideo = () => { setVideoBlob(null); setVideoUrl(''); setVideoS3Url(''); };

  // ── Step 3: Submit ────────────────────────────────────────────────────────
  const submit = async () => {
    if (!form.fullName || !form.dob || !form.mobile) { alert('All fields are required'); return; }
    setSubmitting(true);
    try {
      const r = await fetch('/api/auth/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          aadhaarNumber: aadhaarNumber.replace(/[\s-]/g,''),
          mobile:    form.mobile,
          fullName:  form.fullName,
          dob:       form.dob,
          videoKycUrl: videoS3Url,
        }),
      });
      const d = await r.json();
      if (d.success) {
        setRecoveryId(d.recoveryId);
        setStatusMsg(d.message);
        setStep('submitted');
      } else {
        alert(d.message || 'Submission failed');
      }
    } finally { setSubmitting(false); }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-dark-700">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-xs mb-2 block">← Back to Login</button>
        <h1 className="text-lg font-bold">🔐 Account Recovery</h1>
        <p className="text-gray-400 text-xs mt-0.5">Recover access using your Aadhaar card and a short video</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center px-4 py-3 gap-2">
        {['Aadhaar Check','Record Video','Your Details','Submitted'].map((s,i) => {
          const steps = ['aadhaar_check','record_video','details','submitted'];
          const done  = steps.indexOf(step) > i;
          const cur   = steps[i] === step;
          return (
            <React.Fragment key={s}>
              <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold flex-shrink-0 ${done?'bg-green-500 text-white':cur?'bg-yellow-500 text-black':'bg-dark-700 text-gray-500'}`}>
                {done ? '✓' : i+1}
              </div>
              <span className={`text-[10px] flex-shrink-0 ${cur?'text-yellow-400 font-medium':'text-gray-600'}`}>{s}</span>
              {i < 3 && <div className="flex-1 h-px bg-dark-700"/>}
            </React.Fragment>
          );
        })}
      </div>

      <div className="flex-1 px-4 py-4 space-y-4">

        {/* STEP 1: AADHAAR CHECK */}
        {step === 'aadhaar_check' && (
          <div className="space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-xs text-gray-300 space-y-1.5">
              <p className="font-semibold text-white">Before you start</p>
              <p>• Your Aadhaar card must have been used for KYC on your account</p>
              <p>• You will need to record a short video holding your Aadhaar card</p>
              <p>• Make sure the Aadhaar number, your name, and your face are all clearly visible</p>
              <p>• Our team reviews all requests within 24 hours</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Enter your Aadhaar Card Number</label>
              <input value={aadhaarNumber} onChange={e => setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                placeholder="1234 5678 9012"
                maxLength={12}
                className="w-full bg-dark-800 border border-dark-600 focus:border-yellow-500/50 rounded-xl px-4 py-3.5 text-white font-mono text-lg tracking-[0.3em] outline-none text-center uppercase"/>
              {aadhaarError && <p className="text-red-400 text-xs mt-2">{aadhaarError}</p>}
            </div>
            <button onClick={checkAadhaar} disabled={checking || aadhaarNumber.replace(/\D/g, '').length < 12}
              className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-bold py-3.5 rounded-xl transition-all active:scale-95">
              {checking ? '⏳ Checking…' : 'Find My Account →'}
            </button>
          </div>
        )}

        {/* STEP 2: RECORD VIDEO */}
        {step === 'record_video' && (
          <div className="space-y-4">
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-xs text-gray-300 space-y-1.5">
              <p className="font-semibold text-white">✅ Account found! Now record your verification video</p>
              <p>Hold your Aadhaar card in front of the camera and say:</p>
              <p className="bg-dark-700 rounded-lg p-2 font-mono text-white text-center">"My name is [NAME], I am recovering my BettingBazaar account"</p>
              <p>• Aadhaar card must be clearly readable in the video</p>
              <p>• Your face must be visible alongside the card</p>
              <p>• Minimum 5 seconds, maximum 30 seconds</p>
              <p>• Good lighting helps speed up verification</p>
            </div>

            {/* Video preview */}
            <div className="relative bg-black rounded-2xl overflow-hidden aspect-video">
              <video ref={videoElRef} muted playsInline className="w-full h-full object-cover"/>
              {videoUrl && !recording && (
                <video src={videoUrl} controls className="absolute inset-0 w-full h-full object-cover"/>
              )}
              {!recording && !videoUrl && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-600">
                  <div className="text-center"><div className="text-4xl mb-2">📹</div><p className="text-sm">Camera preview</p></div>
                </div>
              )}
              {recording && (
                <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-red-500/90 text-white text-xs font-bold px-2.5 py-1 rounded-full">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse"/> RECORDING
                </div>
              )}
            </div>

            {!videoUrl ? (
              <button onClick={recording ? stopRecording : startRecording}
                className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95 ${recording?'bg-red-600 hover:bg-red-500 text-white':'bg-green-600 hover:bg-green-500 text-white'}`}>
                {recording ? '⏹ Stop Recording' : '● Start Recording'}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-center text-green-400 text-sm font-medium">✅ Video recorded!</p>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={retakeVideo} className="py-3 rounded-xl border border-dark-600 text-gray-300 text-sm font-medium hover:border-dark-500">↺ Retake</button>
                  <button onClick={uploadVideo} disabled={uploading}
                    className="py-3 rounded-xl bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-bold text-sm transition-all active:scale-95">
                    {uploading ? '⏳ Uploading…' : 'Use This Video →'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 3: DETAILS */}
        {step === 'details' && (
          <div className="space-y-4">
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-3 text-xs text-gray-300">
              <p>✅ Video uploaded. Fill in your details exactly as they appear on your Aadhaar card.</p>
            </div>
            {[
              { label:'Full Name (as on Aadhaar Card)', key:'fullName', type:'text', ph:'RAHUL KUMAR SHARMA' },
              { label:'Date of Birth (as on Aadhaar)',  key:'dob',      type:'date', ph:'' },
              { label:'Contact Mobile Number',      key:'mobile',   type:'tel',  ph:'9876543210' },
            ].map(f => (
              <div key={f.key}>
                <label className="text-xs text-gray-400 mb-1 block">{f.label}</label>
                <input type={f.type} value={(form as any)[f.key]} placeholder={f.ph}
                  onChange={e => setForm(fm => ({...fm, [f.key]: f.key==='fullName'?e.target.value.toUpperCase():e.target.value}))}
                  className="w-full bg-dark-800 border border-dark-600 focus:border-yellow-500/50 rounded-xl px-4 py-3 text-white outline-none"/>
              </div>
            ))}
            <button onClick={submit} disabled={submitting}
              className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-bold py-3.5 rounded-xl transition-all active:scale-95">
              {submitting ? '⏳ Submitting…' : '🔐 Submit Recovery Request'}
            </button>
          </div>
        )}

        {/* STEP 4: SUBMITTED */}
        {step === 'submitted' && (
          <div className="flex flex-col items-center text-center space-y-5 py-8">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center text-3xl">🎉</div>
            <div>
              <h2 className="text-xl font-bold text-green-400">Request Submitted!</h2>
              <p className="text-gray-400 text-sm mt-2">{statusMsg}</p>
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 w-full text-left space-y-2 text-xs">
              <p className="font-semibold text-white">Your Recovery ID</p>
              <p className="font-mono text-yellow-400 text-lg">{recoveryId}</p>
              <p className="text-gray-500">Save this ID to track your request status</p>
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 w-full text-left space-y-1.5 text-xs text-gray-400">
              <p>📋 Our team will review your Aadhaar card video within 24 hours</p>
              <p>📞 We will contact you on {form.mobile} with your new login details</p>
              <p>🔐 You will receive a temporary password — change it immediately</p>
            </div>
            <button onClick={() => navigate('/login')} className="w-full border border-dark-600 text-gray-300 py-3 rounded-xl text-sm hover:border-dark-500">
              ← Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

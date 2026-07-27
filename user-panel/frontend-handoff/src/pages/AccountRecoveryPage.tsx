// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AccountRecoveryPage.tsx — 2026 "Bazaar" redesign.
 *
 * Aadhaar + live-video KYC account recovery. The flow and every API call are
 * unchanged (check-aadhaar → record video → presigned upload → submit recover);
 * only the presentation is rebuilt on the redesign theme tokens.
 */
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import ScreenShell, { card, goldButton, inputStyle, fieldLabel } from '../redesign/Screen';

type Step = 'aadhaar_check' | 'record_video' | 'details' | 'submitted';
const STEPS: Step[] = ['aadhaar_check', 'record_video', 'details', 'submitted'];
const STEP_LABELS = ['Aadhaar', 'Video', 'Details', 'Done'];

export default function AccountRecoveryPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('aadhaar_check');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [checking, setChecking] = useState(false);
  const [aadhaarError, setAadhaarError] = useState('');
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoS3Url, setVideoS3Url] = useState('');
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ fullName: '', dob: '', mobile: '' });
  const [submitting, setSubmitting] = useState(false);
  const [recoveryId, setRecoveryId] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const chunksRef = useRef<Blob[]>([]);

  const checkAadhaar = async () => {
    const clean = aadhaarNumber.replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(clean)) { setAadhaarError('Invalid Aadhaar format. Enter 12 digits.'); return; }
    setChecking(true); setAadhaarError('');
    try {
      const r = await fetch('/api/auth/check-aadhaar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ aadhaarNumber: clean }) });
      const d = await r.json();
      if (d.success) setStep('record_video');
      else setAadhaarError(d.message || 'Unable to process request. Please try again.');
    } catch { setAadhaarError('Network error. Please try again.'); }
    finally { setChecking(false); }
  };

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
        setVideoBlob(blob); setVideoUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        if (videoElRef.current) videoElRef.current.srcObject = null;
      };
      mr.start(); mediaRef.current = mr; setRecording(true);
    } catch { alert('Camera/microphone access is required for video KYC.'); }
  };
  const stopRecording = () => { mediaRef.current?.stop(); setRecording(false); };

  const uploadVideo = async () => {
    if (!videoBlob) return;
    setUploading(true);
    try {
      const r1 = await fetch('/api/user/kyc/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ fileName: 'recovery_video.webm', contentType: 'video/webm', fileSize: videoBlob.size, docType: 'recovery_video' }) });
      const u = await r1.json();
      if (!u.success) throw new Error(u.message);
      await fetch(u.uploadUrl, { method: 'PUT', body: videoBlob, headers: { 'Content-Type': 'video/webm' } });
      setVideoS3Url(u.cdnUrl); setStep('details');
    } catch (e: any) { alert('Upload failed: ' + e.message); }
    finally { setUploading(false); }
  };
  const retakeVideo = () => { setVideoBlob(null); setVideoUrl(''); setVideoS3Url(''); };

  const submit = async () => {
    if (!form.fullName || !form.dob || !form.mobile) { alert('All fields are required'); return; }
    setSubmitting(true);
    try {
      const r = await fetch('/api/auth/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ aadhaarNumber: aadhaarNumber.replace(/[\s-]/g, ''), mobile: form.mobile, fullName: form.fullName, dob: form.dob, videoKycUrl: videoS3Url }) });
      const d = await r.json();
      if (d.success) { setRecoveryId(d.recoveryId); setStatusMsg(d.message); setStep('submitted'); }
      else alert(d.message || 'Submission failed');
    } finally { setSubmitting(false); }
  };

  const curIdx = STEPS.indexOf(step);

  return (
    <ScreenShell icon="🔑" title="Account Recovery" sub="Regain access with Aadhaar + video">
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
          {STEP_LABELS.map((s, i) => {
            const done = curIdx > i, cur = curIdx === i;
            return (
              <React.Fragment key={s}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 24, height: 24, borderRadius: '50%', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? 'var(--green)' : cur ? 'var(--gold)' : 'var(--surface3)', color: done ? '#fff' : cur ? '#1a1200' : 'var(--text3)' }}>{done ? '✓' : i + 1}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: cur ? 'var(--gold-ink)' : 'var(--text3)' }}>{s}</span>
                </div>
                {i < 3 && <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />}
              </React.Fragment>
            );
          })}
        </div>

        <div style={{ background: 'color-mix(in srgb,var(--gold) 8%,var(--surface))', border: '1px solid var(--line2)', borderRadius: 16, padding: 15, marginBottom: 14, display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 20 }}>🔑</span><span style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text2)' }}>Lost access to your number or password? Verify your identity with Aadhaar and a live selfie video to recover your account securely.</span>
        </div>

        {step === 'aadhaar_check' && (
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><label style={fieldLabel}>Aadhaar number</label><input value={aadhaarNumber} onChange={e => setAadhaarNumber(e.target.value)} inputMode="numeric" placeholder="1234 5678 9012" className="font-grotesk" style={{ ...inputStyle, letterSpacing: '.1em' }} /></div>
            {aadhaarError && <p style={{ color: 'var(--red)', fontSize: 12, margin: 0 }}>{aadhaarError}</p>}
            <button onClick={checkAadhaar} disabled={checking} style={{ ...goldButton, opacity: checking ? .6 : 1 }}>{checking ? 'Checking…' : 'Continue'}</button>
          </div>
        )}

        {step === 'record_video' && (
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: '2px dashed var(--line2)', borderRadius: 13, padding: 14, textAlign: 'center', background: 'var(--surface2)' }}>
              <div style={{ fontSize: 26, marginBottom: 6 }}>🎥</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Record a live video holding your Aadhaar</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>Keep the card readable and your face in frame</div>
              <div style={{ marginTop: 12, borderRadius: 12, overflow: 'hidden', background: '#000', display: (recording || videoUrl) ? 'block' : 'none' }}>
                <video ref={videoElRef} src={videoUrl || undefined} controls={!!videoUrl && !recording} muted={recording} playsInline style={{ width: '100%', maxHeight: 260, background: '#000' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
                {!recording && !videoUrl && <button onClick={startRecording} style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--surface3)', color: 'var(--gold-ink)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Start recording</button>}
                {recording && <button onClick={stopRecording} style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: 'var(--red)', color: '#fff', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>⏹ Stop</button>}
                {videoUrl && !recording && <button onClick={retakeVideo} style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--surface3)', color: 'var(--text2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Retake</button>}
              </div>
            </div>
            <button onClick={uploadVideo} disabled={!videoBlob || uploading} style={{ ...goldButton, opacity: (!videoBlob || uploading) ? .5 : 1 }}>{uploading ? 'Uploading…' : 'Continue'}</button>
          </div>
        )}

        {step === 'details' && (
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><label style={fieldLabel}>Full name (as on Aadhaar)</label><input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="RAHUL SHARMA" style={{ ...inputStyle, textTransform: 'uppercase' }} /></div>
            <div><label style={fieldLabel}>Date of birth</label><input value={form.dob} onChange={e => setForm({ ...form, dob: e.target.value })} placeholder="DD/MM/YYYY" style={inputStyle} /></div>
            <div><label style={fieldLabel}>New contact mobile</label><input value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value.replace(/[^0-9]/g, '').slice(0, 10) })} inputMode="numeric" placeholder="9876543210" className="font-grotesk" style={inputStyle} /></div>
            <button onClick={submit} disabled={submitting} style={{ ...goldButton, opacity: submitting ? .6 : 1 }}>{submitting ? 'Submitting…' : 'Submit recovery request'}</button>
            <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, textAlign: 'center', margin: 0 }}>Our team reviews recovery requests within 24 hours. You'll be contacted on your new number.</p>
          </div>
        )}

        {step === 'submitted' && (
          <div style={{ ...card, textAlign: 'center', padding: 22 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>Request submitted</div>
            <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, lineHeight: 1.5 }}>{statusMsg || 'Our team will review your video and get back to you within 24 hours.'}</p>
            {recoveryId && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text3)' }}>Reference: <span className="font-grotesk" style={{ color: 'var(--text2)' }}>{recoveryId}</span></div>}
            <button onClick={() => navigate('/')} style={{ ...goldButton, marginTop: 16 }}>Back to Home</button>
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

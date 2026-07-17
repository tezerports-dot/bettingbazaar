// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { CheckCircle, XCircle, RefreshCw, Video, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

export const AccountRecoveryAdmin: React.FC = () => {
  const [requests, setRequests] = useState<any[]>([]);
  const [status, setStatus]     = useState('pending');
  const [loading, setLoading]   = useState(true);
  const [processing, setProcessing] = useState<string|null>(null);
  const [approved, setApproved] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/api/admin/account-recovery?status=${status}`);
      if (r.data.success) setRequests(r.data.requests);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [status]);

  const approve = async (id: string) => {
    setProcessing(id);
    try {
      const r = await api.post(`/api/admin/account-recovery/${id}/approve`, {});
      if (r.data.success) {
        setApproved(r.data);
        toast.success('Account recovery approved!');
        load();
      }
    } catch (e: any) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setProcessing(null); }
  };

  const reject = async (id: string) => {
    const reason = prompt('Rejection reason (required — shown to user):');
    if (!reason) return;
    setProcessing(id);
    try {
      await api.post(`/api/admin/account-recovery/${id}/reject`, { adminNote: reason });
      toast.success('Request rejected');
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setProcessing(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Account Recovery Queue</h1>
          <p className="text-gray-400 text-sm mt-1">
            Review Aadhaar card video KYC submissions. Watch the video — verify the user's face
            AND the Aadhaar card number/name match the registered account.
          </p>
        </div>
        <button onClick={load} className="btn-secondary flex items-center gap-2"><RefreshCw size={14}/>Refresh</button>
      </div>

      {/* Temp password modal */}
      {approved && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={(e)=>{if(e.target===e.currentTarget)setApproved(null);}}>
          <div className="bg-dark-800 border border-green-500/40 rounded-2xl p-6 max-w-md w-full space-y-4">
            <div className="text-center">
              <div className="text-4xl mb-2">🔐</div>
              <h2 className="text-xl font-bold text-green-400">Recovery Approved!</h2>
              <p className="text-gray-400 text-sm mt-1">Share these login details with the user securely</p>
            </div>
            <div className="bg-dark-700 border border-dark-600 rounded-xl p-4 space-y-3">
              <div className="flex justify-between text-sm"><span className="text-gray-400">Username</span><span className="font-mono text-white">{approved.username}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-400">Mobile</span><span className="font-mono text-white">{approved.mobile}</span></div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Temp Password</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-yellow-400 text-lg font-bold tracking-wider">{approved.tempPassword}</span>
                  <button onClick={() => { navigator.clipboard.writeText(approved.tempPassword); toast.success('Copied!'); }}
                    className="text-xs text-gray-500 hover:text-white border border-dark-600 px-2 py-1 rounded">Copy</button>
                </div>
              </div>
            </div>
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-300 space-y-1">
              <p className="font-semibold">⚠️ This password is shown ONCE and cannot be retrieved again</p>
              <p>• Share with the user via SMS or phone call only</p>
              <p>• User must change password immediately after login</p>
              <p>• Do NOT share via chat or email</p>
            </div>
            <button onClick={() => setApproved(null)} className="w-full btn-primary">I have shared the password — Close</button>
          </div>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex gap-2">
        {['pending','approved','rejected'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${status===s?'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30':'bg-dark-700 text-gray-400 hover:bg-dark-600'}`}>
            {s}
          </button>
        ))}
      </div>

      {/* How-to guide */}
      {status === 'pending' && requests.length > 0 && (
        <div className="card border border-blue-500/20 bg-blue-500/5 text-xs text-gray-300 space-y-1">
          <p className="font-semibold text-white">How to review a recovery request:</p>
          <p>1. Click "▶ Watch Video" — the user should be holding their Aadhaar card clearly visible</p>
          <p>2. Check: <strong>face visible</strong>, <strong>Aadhaar number readable</strong>, <strong>name on Aadhaar matches request</strong></p>
          <p>3. If all three match → Approve. If suspicious → Reject with reason.</p>
          <p>4. After approval, you will see the temp password <strong>once only</strong> — share it immediately with the user.</p>
        </div>
      )}

      {/* Requests */}
      {loading
        ? <div className="flex justify-center py-12"><RefreshCw className="animate-spin text-yellow-400" size={28}/></div>
        : requests.length === 0
          ? <div className="text-center py-12 text-gray-500">No {status} requests</div>
          : <div className="space-y-4">
              {requests.map(req => (
                <div key={req._id} className={`card space-y-4 border ${req.status==='pending'?'border-yellow-500/20':req.status==='approved'?'border-green-500/20':'border-red-500/20'}`}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-gray-500">{req.recoveryId}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${req.status==='pending'?'bg-yellow-500/20 text-yellow-400':req.status==='approved'?'bg-green-500/20 text-green-400':'bg-red-500/20 text-red-400'}`}>
                          {req.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm mt-2">
                        <div><p className="text-gray-500 text-xs">Claimant Name</p><p className="font-medium">{req.fullName}</p></div>
                        <div><p className="text-gray-500 text-xs">DOB on Aadhaar</p><p className="font-medium">{req.dob}</p></div>
                        <div><p className="text-gray-500 text-xs">Contact Mobile</p><p className="font-medium">{req.mobile}</p></div>
                        <div><p className="text-gray-500 text-xs">Registered Account</p><p className="font-medium">{req.userId?.username} · {req.userId?.mobile}</p></div>
                        <div><p className="text-gray-500 text-xs">Submitted</p><p className="font-medium">{new Date(req.createdAt).toLocaleString()}</p></div>
                        {req.processedBy && <div><p className="text-gray-500 text-xs">Processed By</p><p className="font-medium">{req.processedBy?.username}</p></div>}
                      </div>
                      {req.adminNote && <p className="text-xs mt-1 text-gray-400">Note: {req.adminNote}</p>}
                    </div>
                  </div>

                  {/* Video KYC */}
                  <div className="flex items-center gap-3">
                    <a href={req.videoKycUrl} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 bg-blue-500/10 text-blue-400 border border-blue-500/30 px-4 py-2 rounded-lg text-sm hover:bg-blue-500/20 transition-colors">
                      <Video size={14}/> ▶ Watch Aadhaar Card Video
                    </a>
                    {req.selfieUrl && (
                      <a href={req.selfieUrl} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 bg-dark-700 text-gray-300 border border-dark-600 px-4 py-2 rounded-lg text-sm hover:bg-dark-600">
                        🖼 View Selfie
                      </a>
                    )}
                  </div>

                  {req.status === 'pending' && (
                    <div className="flex gap-3 pt-2 border-t border-dark-600">
                      <button onClick={() => approve(req._id)} disabled={processing === req._id}
                        className="flex items-center gap-2 bg-green-500/10 text-green-400 border border-green-500/30 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-green-500/20 transition-all disabled:opacity-50">
                        <CheckCircle size={15}/>{processing===req._id?'Processing…':'Approve & Issue Temp Password'}
                      </button>
                      <button onClick={() => reject(req._id)} disabled={processing === req._id}
                        className="flex items-center gap-2 bg-red-500/10 text-red-400 border border-red-500/30 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-red-500/20 transition-all disabled:opacity-50">
                        <XCircle size={15}/>Reject Request
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
      }
    </div>
  );
};

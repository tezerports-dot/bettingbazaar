// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect, createContext, useContext, useRef } from 'react';
// Fix: Import logic components and hooks from 'react-router'
import { Routes, Route, Navigate, useParams, useNavigate } from 'react-router';
// Fix: Import DOM components from 'react-router-dom'
import { Link } from 'react-router-dom';
import { getBackend, getAssetUrl } from './services/backend.service';
import { PaymentOrder, MerchantProfile, ChatMessage, User } from './types';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { Show } from './components/ui/Show';
import Modal from './components/ui/Modal';

const backend = getBackend();

// --- CONTEXT ---
interface MerchantAuthContextType {
    merchant: MerchantProfile | null;
    user: User | null; 
    login: (id: string, pass: string, code?: string) => Promise<{ success: boolean, requires2FA?: boolean, user?: User }>;
    logout: () => void;
    refreshProfile: () => Promise<void>;
}

const MerchantAuthContext = createContext<MerchantAuthContextType | undefined>(undefined);

export const useMerchantAuth = () => {
    const context = useContext(MerchantAuthContext);
    if (!context) throw new Error("useMerchantAuth must be used within MerchantAuthProvider");
    return context;
};

export const MerchantAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [merchant, setMerchant] = useState<MerchantProfile | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const storedMerchant = localStorage.getItem('merchant_session');
        const storedUser = localStorage.getItem('merchant_user_session');
        const restore = async () => {
            try {
                if (storedMerchant) {
                    const parsedM = JSON.parse(storedMerchant);
                    const freshM = await backend.getMerchantProfile(parsedM.id);
                    setMerchant(freshM);
                }
                if (storedUser) {
                    const parsedU = JSON.parse(storedUser);
                    const freshUData = await backend.getUserData(parsedU.id);
                    if(freshUData) setUser(freshUData.user);
                }
            } catch(e) { 
                localStorage.removeItem('merchant_session');
                localStorage.removeItem('merchant_user_session');
            } finally {
                setLoading(false);
            }
        };
        restore();
    }, []);

    const login = async (id: string, pass: string, code?: string) => {
        try {
            const res = await backend.merchantLogin(id, pass);
            if(res.success) {
                if (res.merchant) {
                    setMerchant(res.merchant);
                    localStorage.setItem('merchant_session', JSON.stringify(res.merchant));
                }
                if (res.user) {
                    setUser(res.user);
                    localStorage.setItem('merchant_user_session', JSON.stringify(res.user));
                }
                return { success: true, user: res.user };
            }
            return { success: false };
        } catch(e) { return { success: false }; }
    };

    const logout = () => {
        setMerchant(null);
        setUser(null);
        localStorage.removeItem('merchant_session');
        localStorage.removeItem('merchant_user_session');
    };

    const refreshProfile = async () => {
        if (merchant) {
            const fresh = await backend.getMerchantProfile(merchant.id);
            setMerchant(fresh);
            localStorage.setItem('merchant_session', JSON.stringify(fresh));
        }
        if (user) {
            const freshUserData = await backend.getUserData(user.id);
            if (freshUserData) setUser(freshUserData.user);
        }
    };

    if (loading) return <div className="min-h-screen bg-[#0B0E14] flex items-center justify-center text-[#D4AF37]">Loading Portal...</div>;

    return (
        <MerchantAuthContext.Provider value={{ merchant, user, login, logout, refreshProfile }}>
            {children}
        </MerchantAuthContext.Provider>
    );
};

export const MerchantLogin = () => {
    const { login } = useMerchantAuth();
    const navigate = useNavigate();
    const [id, setId] = useState('');
    const [pass, setPass] = useState('');
    const [code, setCode] = useState('');
    const [step, setStep] = useState<'AUTH' | '2FA'>('AUTH');
    const [captcha, setCaptcha] = useState({ q: '5 + 3', a: 8 });
    const [captchaInput, setCaptchaInput] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const generateCaptcha = () => {
        const n1 = Math.floor(Math.random() * 9) + 1;
        const n2 = Math.floor(Math.random() * 9) + 1;
        setCaptcha({ q: `${n1} + ${n2}`, a: n1 + n2 });
        setCaptchaInput('');
    };

    useEffect(() => { generateCaptcha(); }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (parseInt(captchaInput) !== captcha.a) {
            setError("Security check failed.");
            generateCaptcha();
            return;
        }

        setLoading(true);
        setError('');
        const res = await login(id, pass, code);
        setLoading(false);

        if (res.success) {
            if (res.user?.isQueueManager) navigate('/merchant/queue');
            else navigate('/merchant/dashboard');
        } else if (res.requires2FA) {
            setStep('2FA');
        } else {
            setError('Unauthorized: Check Credentials');
            generateCaptcha();
        }
    };

    return (
        <div className="min-h-screen bg-[#0B0E14] flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-[#1E293B] p-8 rounded-2xl border border-slate-700 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#D4AF37]"></div>
                <div className="text-center mb-8">
                    <h1 className="text-2xl font-bold text-white tracking-wider uppercase">Staff Access</h1>
                    <p className="text-[#D4AF37] text-[10px] uppercase tracking-[0.2em] mt-1">Authorized Entry Only</p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-6">
                    {step === 'AUTH' ? (
                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] text-slate-400 font-black uppercase mb-1 block">Staff ID / Mobile</label>
                                <input value={id} onChange={e => setId(e.target.value)} className="w-full bg-[#0F172A] border border-slate-600 rounded p-3 text-white focus:border-[#D4AF37] outline-none font-mono" />
                            </div>
                            <div>
                                <label className="text-[10px] text-slate-400 font-black uppercase mb-1 block">Security Key</label>
                                <input type="password" value={pass} onChange={e => setPass(e.target.value)} className="w-full bg-[#0F172A] border border-slate-600 rounded p-3 text-white focus:border-[#D4AF37] outline-none" />
                            </div>
                            <div className="flex items-center gap-4 bg-black/30 p-3 rounded border border-white/5">
                                <div className="text-xs text-slate-400 font-bold uppercase shrink-0">Human Check: <span className="text-white ml-1">{captcha.q} =</span></div>
                                <input type="number" value={captchaInput} onChange={e => setCaptchaInput(e.target.value)} className="w-full bg-transparent border-b border-slate-600 text-center text-white focus:border-[#D4AF37] outline-none font-black" placeholder="?" required />
                            </div>
                        </div>
                    ) : null}
                    {step === '2FA' ? (
                        <div className="text-center">
                            <p className="text-slate-300 text-sm mb-4">Enter Auth Code</p>
                            <input type="text" value={code} onChange={e => setCode(e.target.value.replace(/\D/g,''))} className="w-full bg-[#0F172A] border border-slate-600 rounded p-3 text-center text-white text-2xl tracking-[0.5em] outline-none font-mono" maxLength={6} autoFocus />
                        </div>
                    ) : null}
                    {error !== '' ? (
                        <div className="text-red-500 text-[10px] text-center font-black uppercase tracking-tighter bg-red-900/20 p-2 rounded border border-red-500/30">{error}</div>
                    ) : null}
                    <button type="submit" disabled={loading} className="w-full bg-[#D4AF37] hover:bg-[#B8860B] text-black font-black py-4 rounded-xl transition-all active:scale-95 disabled:opacity-50 uppercase text-xs tracking-widest shadow-lg shadow-yellow-900/20">
                        {loading ? 'Authenticating...' : 'Enter Console'}
                    </button>
                </form>
            </div>
        </div>
    );
};

export const MerchantDashboard = () => {
    const { merchant, user, logout, refreshProfile } = useMerchantAuth();
    const navigate = useNavigate();
    const [orders, setOrders] = useState<PaymentOrder[]>([]);
    const [activeTab, setActiveTab] = useState<'TASKS' | 'HISTORY' | 'SETTINGS'>('TASKS');
    
    // Settings States
    const [upiId, setUpiId] = useState('');
    const [qrUrl, setQrUrl] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const qrInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (merchant) {
            refreshProfile();
            setUpiId(merchant.bankDetails?.upiId || '');
            setQrUrl(merchant.qrCodeUrl || '');
            const load = () => backend.getMerchantOrders(merchant.id).then(setOrders);
            load();
            const interval = setInterval(() => {
                load();
                refreshProfile();
            }, 5000); 
            return () => clearInterval(interval);
        }
    }, [merchant?.id]);

    if (!merchant && user?.isQueueManager) return <Navigate to="/merchant/queue" replace />;
    if (!merchant) return <Navigate to="/merchant/login" replace />;

    const toggleOnline = async () => {
        await backend.updateMerchantProfile(merchant.id, { isOnline: !merchant.isOnline });
        refreshProfile();
    };

    const handleAction = async (orderId: string, action: 'CONFIRM' | 'REJECT') => {
        const order = orders.find(o => o.id === orderId);
        if (!order) return;

        if (action === 'REJECT') {
            const reason = prompt("Security: Enter Rejection Reason (Logs required):");
            if (!reason) return;
            await backend.updateOrderStatus(orderId, 'CANCELLED', merchant.id);
        } else {
            const nextStatus = order.type === 'DEPOSIT' ? 'COMPLETED' : 'PAID';
            if (confirm("Confirming this will finalize the financial transaction. Proceed?")) {
                await backend.updateOrderStatus(orderId, nextStatus, merchant.id);
            }
        }
        backend.getMerchantOrders(merchant.id).then(setOrders);
    };

    const handleSaveSettings = async () => {
        setIsSaving(true);
        try {
            await backend.updateMerchantProfile(merchant.id, {
                bankDetails: { ...merchant.bankDetails, upiId: upiId },
                qrCodeUrl: qrUrl
            });
            await refreshProfile();
            alert("Security: Merchant profile hardened and updated.");
        } catch (e: any) {
            alert("Update Failed: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleQRUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setIsSaving(true);
            try {
                const url = await backend.uploadFile(e.target.files[0]);
                setQrUrl(url);
            } catch (err) {
                alert("Upload failed");
            } finally {
                setIsSaving(false);
            }
        }
    };

    const activeOrders = orders.filter(o => ['ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED'].includes(o.status));

    return (
        <div className="p-4 md:p-8 max-w-6xl mx-auto pb-24">
            <header className="flex flex-col md:flex-row justify-between items-center mb-8 bg-[#1E293B] p-4 rounded-xl border border-slate-700 shadow-lg">
                <div className="mb-4 md:mb-0 text-center md:text-left">
                    <h1 className="text-xl font-bold text-white flex items-center justify-center md:justify-start gap-2">
                        {merchant.name} 
                        <span className={`w-3 h-3 rounded-full ${merchant.isOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
                    </h1>
                    <div className="text-[10px] text-slate-400 font-mono">ACCOUNT: {merchant.id}</div>
                </div>
                <div className="flex items-center gap-4">
                    <button 
                        onClick={toggleOnline}
                        className={`px-6 py-2 rounded-lg font-bold text-sm transition-colors shadow-lg ${merchant.isOnline ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}
                    >
                        {merchant.isOnline ? 'GO OFFLINE' : 'GO ONLINE'}
                    </button>
                    <button onClick={logout} className="text-slate-400 hover:text-white text-sm bg-slate-800 px-4 py-2 rounded">Logout</button>
                </div>
            </header>

            <div className="flex mb-4 bg-[#1E293B] p-1 rounded-lg w-fit mx-auto md:mx-0">
                {['TASKS', 'HISTORY', 'SETTINGS'].map(t => (
                    <button key={t} onClick={() => setActiveTab(t as any)} className={`px-6 py-2 text-xs font-bold rounded ${activeTab === t ? 'bg-[#D4AF37] text-black' : 'text-slate-400'}`}>{t}</button>
                ))}
            </div>

            <div className="bg-[#1E293B] rounded-xl border border-slate-700 overflow-hidden min-h-[400px]">
                {activeTab === 'TASKS' ? (
                    <div className="divide-y divide-slate-700">
                        {activeOrders.length === 0 ? (
                            <div className="p-12 text-center text-slate-500 italic">Queue clear. No pending security alerts or tasks.</div>
                        ) : (
                            activeOrders.map(order => (
                                <div key={order.id} className="p-4 flex flex-col lg:flex-row justify-between items-center gap-4 hover:bg-slate-800/50 transition-colors">
                                    <div className="flex-1 text-center lg:text-left">
                                        <div className="flex items-center justify-center lg:justify-start gap-2 mb-1">
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${order.type==='DEPOSIT'?'bg-green-900/30 text-green-400 border-green-500/30':'bg-red-900/30 text-red-400 border-red-500/30'}`}>
                                                {order.type}
                                            </span>
                                            <span className="text-white font-black text-xl">₹ {order.amount.toLocaleString()}</span>
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-mono">{order.id} • {new Date(order.createdAt).toLocaleTimeString()}</div>
                                    </div>
                                    <div className="text-xs font-bold text-[#D4AF37] uppercase bg-black/30 px-3 py-1 rounded-full border border-white/5">{order.status}</div>
                                    <div className="flex gap-2 w-full lg:w-auto">
                                        {order.status === 'ASSIGNED' || order.status === 'PAID' ? (
                                            <>
                                                <button onClick={() => handleAction(order.id, 'REJECT')} className="flex-1 lg:flex-none px-4 py-2 bg-red-900/50 border border-red-500/30 text-red-400 hover:bg-red-600 hover:text-white rounded text-xs font-bold transition-all">Reject</button>
                                                <button onClick={() => handleAction(order.id, 'CONFIRM')} className="flex-1 lg:flex-none px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-bold shadow-lg shadow-green-900/20 transition-all">
                                                    {order.type === 'DEPOSIT' ? 'Confirm Receipt' : 'Confirm Sent'}
                                                </button>
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                ) : null}
                
                {activeTab === 'HISTORY' ? (
                    <div className="p-12 text-center text-slate-500 italic">No recent history logs.</div>
                ) : null}

                {activeTab === 'SETTINGS' ? (
                    <div className="p-8 space-y-6 max-w-lg">
                        <h3 className="text-lg font-bold text-white border-b border-slate-700 pb-2">Business Configuration</h3>
                        
                        <div className="space-y-4">
                             <div>
                                <label className="text-[10px] text-slate-500 uppercase font-black mb-1 block">Your Public UPI ID</label>
                                <input 
                                    type="text" 
                                    value={upiId} 
                                    onChange={e => setUpiId(e.target.value)}
                                    placeholder="merchant@upi"
                                    className="w-full bg-[#0F172A] border border-slate-600 rounded p-3 text-white focus:border-[#D4AF37] outline-none font-mono"
                                />
                                <p className="text-[9px] text-slate-600 mt-1">Users will pay to this ID for token purchases.</p>
                             </div>

                             <div className="pt-2">
                                <label className="text-[10px] text-slate-500 uppercase font-black mb-1 block">Payment QR Code</label>
                                <div className="flex items-start gap-4">
                                    <div className="w-32 h-32 bg-black rounded border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
                                        {qrUrl !== '' ? (
                                            <img src={getAssetUrl(qrUrl)} className="w-full h-full object-contain" alt="Merchant QR" />
                                        ) : (
                                            <span className="text-[10px] text-slate-600 text-center px-2">No QR Uploaded</span>
                                        )}
                                    </div>
                                    <div className="space-y-2">
                                        <input type="file" ref={qrInputRef} className="hidden" accept="image/*" onChange={handleQRUpload} />
                                        <button 
                                            onClick={() => qrInputRef.current?.click()}
                                            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded transition-colors"
                                        >
                                            {qrUrl ? 'CHANGE QR CODE' : 'UPLOAD QR CODE'}
                                        </button>
                                        <p className="text-[9px] text-slate-600 leading-relaxed">Please upload a high-quality screenshot of your UPI QR code. Square ratio recommended.</p>
                                    </div>
                                </div>
                             </div>

                             <div className="pt-6 border-t border-slate-700/50">
                                <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-widest">Visibility Toggles</h4>
                                <div className="space-y-3">
                                    <div className="flex justify-between items-center">
                                        <div className="text-sm">
                                            <div className="text-white">Accepting Deposits</div>
                                            <div className="text-[10px] text-slate-500">Show in "Buy Tokens" queue</div>
                                        </div>
                                        <input 
                                            type="checkbox" 
                                            checked={merchant.acceptsDeposits} 
                                            onChange={async e => {
                                                await backend.updateMerchantProfile(merchant.id, { acceptsDeposits: e.target.checked });
                                                refreshProfile();
                                            }}
                                            className="w-5 h-5 accent-[#D4AF37]" 
                                        />
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <div className="text-sm">
                                            <div className="text-white">Accepting Withdrawals</div>
                                            <div className="text-[10px] text-slate-500">Show in "Sell Tokens" queue</div>
                                        </div>
                                        <input 
                                            type="checkbox" 
                                            checked={merchant.acceptsWithdrawals} 
                                            onChange={async e => {
                                                await backend.updateMerchantProfile(merchant.id, { acceptsWithdrawals: e.target.checked });
                                                refreshProfile();
                                            }}
                                            className="w-5 h-5 accent-[#D4AF37]" 
                                        />
                                    </div>
                                </div>
                             </div>

                             <button 
                                onClick={handleSaveSettings}
                                disabled={isSaving}
                                className="w-full bg-[#D4AF37] hover:bg-[#B8860B] text-black font-black py-4 rounded-xl shadow-lg transition-all active:scale-95 disabled:opacity-50 uppercase text-xs tracking-widest mt-4"
                             >
                                {isSaving ? 'Processing...' : 'Save All Settings'}
                             </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export const QueueManagerDashboard = () => {
    const { user, logout } = useMerchantAuth();
    const navigate = useNavigate();
    const [queue, setQueue] = useState<PaymentOrder[]>([]);
    const [merchants, setMerchants] = useState<MerchantProfile[]>([]);

    useEffect(() => {
        const load = () => {
            backend.getAllOrders().then(all => setQueue(all.filter(o => o.status === 'PENDING_QUEUE')));
            backend.getMerchantList().then(setMerchants);
        };
        load();
        const interval = setInterval(load, 5000); 
        return () => clearInterval(interval);
    }, []);

    const handleAssign = async (orderId: string, merchantId: string) => {
        try {
            await backend.assignOrderToMerchant(orderId, merchantId, user?.id || 'staff');
            // Remove from queue after successful assignment - order moves to merchant's active orders
            setQueue(prev => prev.filter(o => o.id !== orderId));

            return;
        } catch(e: any) {
            alert("Assignment Failed: " + e.message);
        }
    };

    // Helper to get compatible merchants for an order
    const getAvailableMerchants = (order: PaymentOrder) => {
        return merchants.filter(m => {
            const isOnline = m.status === 'ACTIVE' && m.isOnline;
            const remainingDailyVol = m.dailyCap - m.currentDailyVolume;
            const hasCap = remainingDailyVol >= order.amount;

            if (order.type === 'DEPOSIT') {
                return isOnline && m.acceptsDeposits && 
                       order.amount >= m.limits.minDeposit && 
                       order.amount <= m.limits.maxDeposit && hasCap;
            } else {
                return isOnline && m.acceptsWithdrawals && 
                       order.amount >= m.limits.minWithdraw && 
                       order.amount <= m.limits.maxWithdraw && hasCap;
            }
        });
    };

    const buyQueue = queue.filter(o => o.type === 'DEPOSIT');
    const sellQueue = queue.filter(o => o.type === 'WITHDRAWAL');

    const QueueTable = ({ title, orders, colorClass }: { title: string, orders: PaymentOrder[], colorClass: string }) => (
        <div className="bg-[#1E293B] rounded-xl border border-slate-700 overflow-hidden shadow-xl mb-8">
            <div className={`p-4 bg-[#0F172A] border-b border-slate-700 font-bold text-sm uppercase tracking-widest flex justify-between items-center ${colorClass}`}>
                <span>{title} ({orders.length})</span>
                <span className="text-[10px] text-slate-500 font-normal italic">Waiting for Staff Action</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead className="bg-black/20 text-[10px] text-slate-500 uppercase font-black">
                        <tr>
                            <th className="px-6 py-3">Order Details</th>
                            <th className="px-6 py-3">Amount</th>
                            <th className="px-6 py-3">Time in Queue</th>
                            <th className="px-6 py-3 text-right">Assign Merchant</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/50">
                        {orders.length === 0 ? (
                            <tr><td colSpan={4} className="p-8 text-center text-slate-600 italic">No pending requests in this category.</td></tr>
                        ) : (
                            orders.map(order => {
                                const eligible = getAvailableMerchants(order);
                                return (
                                    <tr key={order.id} className="hover:bg-slate-800/30 transition-colors group">
                                        <td className="px-6 py-4">
                                            <div className="text-white font-bold text-sm">#{order.id.slice(-8)}</div>
                                            <div className="text-[10px] text-slate-500 font-mono">{order.userId}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className={`font-black text-lg ${order.type === 'DEPOSIT' ? 'text-green-400' : 'text-red-400'}`}>₹ {order.amount.toLocaleString()}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="text-xs text-slate-400">{new Date(order.createdAt).toLocaleTimeString()}</div>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex flex-col items-end gap-2">
                                                <select 
                                                    className="bg-[#0F172A] border border-slate-600 rounded px-3 py-1.5 text-xs text-white outline-none focus:border-[#D4AF37] max-w-[200px]"
                                                    onChange={(e) => {
                                                        if (e.target.value) handleAssign(order.id, e.target.value);
                                                    }}
                                                    defaultValue=""
                                                >
                                                    <option value="" disabled>Select Merchant ({eligible.length})</option>
                                                    {eligible.map(m => (
                                                        <option key={m.id} value={m.id}>
                                                            {m.name} (Cap: ₹{(m.dailyCap - m.currentDailyVolume).toLocaleString()})
                                                        </option>
                                                    ))}
                                                </select>
                                                {eligible.length === 0 ? (
                                                    <span className="text-[9px] text-red-500 font-bold uppercase tracking-tighter">No Eligible Merchants Online</span>
                                                ) : null}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto">
            <header className="flex justify-between items-center mb-8 bg-[#1E293B] p-4 rounded-xl border border-slate-700 shadow-lg">
                <div>
                    <h1 className="text-xl font-bold text-white flex items-center gap-2">
                        <span className="text-blue-500">🛡️</span> Queue Manager
                    </h1>
                    <div className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Live Order Routing System</div>
                </div>
                <button onClick={logout} className="text-slate-400 hover:text-white text-sm bg-slate-800 px-4 py-2 rounded font-bold border border-slate-700 transition-colors">Logout Console</button>
            </header>

            <QueueTable title="Buy Token Requests (Deposits)" orders={buyQueue} colorClass="text-green-400" />
            <QueueTable title="Sell Token Requests (Withdrawals)" orders={sellQueue} colorClass="text-red-400" />
            
            <div className="mt-12 bg-blue-900/10 border border-blue-500/20 p-4 rounded-xl flex items-start gap-4">
                <span className="text-xl">💡</span>
                <p className="text-xs text-slate-400 leading-relaxed">
                    <strong>Operational Note:</strong> Merchants only appear in the dropdown if they are <strong>ONLINE</strong> and have not exceeded their <strong>Daily Capacity</strong>.
                    Assignment is atomic; as soon as you select a merchant, the system locks the order and redirects you to the live P2P chat for oversight.
                </p>
            </div>
        </div>
    );
};

export const MerchantChat = () => {
    const { merchant, user } = useMerchantAuth();
    const { orderId } = useParams();
    const [msgs, setMsgs] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if(orderId) {
            const updateChat = async () => {
                const chatData = await backend.getOrderChat(orderId);
                setMsgs(chatData);
            };
            updateChat();
            const interval = setInterval(updateChat, 3000);
            return () => clearInterval(interval);
        }
    }, [orderId]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [msgs]);

    const send = async () => {
        if(!input.trim() || !orderId || (!merchant && !user)) return;
        const senderId = merchant?.id || user?.id || 'staff'; 
        await backend.sendChatMessage(orderId, senderId, input);
        setInput('');
        const chatData = await backend.getOrderChat(orderId);
        setMsgs(chatData);
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0] && orderId && (merchant || user)) {
            const file = e.target.files[0];
            setIsUploading(true);
            try {
                const url = await backend.uploadFile(file);
                const senderId = merchant?.id || user?.id || 'staff';
                await backend.sendChatMessage(orderId, senderId, "Sent an attachment", false, url);
                const chatData = await backend.getOrderChat(orderId);
                setMsgs(chatData);
            } catch (err) {
                alert("File upload failed");
            } finally {
                setIsUploading(false);
            }
        }
    };

    if (!merchant && !user) return <Navigate to="/merchant/login" />;

    return (
        <div className="flex flex-col h-screen bg-[#0B0E14] text-white">
            <div className="p-4 border-b border-slate-700 bg-[#1E293B] flex items-center justify-between shadow-md z-10">
                <Link to={user?.isQueueManager ? "/merchant/queue" : "/merchant/dashboard"} className="text-slate-400 hover:text-[#D4AF37] text-sm flex items-center gap-1 font-bold">
                    <span>←</span> Exit Chat
                </Link>
                <div className="text-center">
                    <h2 className="font-bold text-[#D4AF37] text-xs uppercase tracking-[0.2em]">Transaction Support</h2>
                    <div className="text-[10px] text-slate-500 font-mono">ORDER ID: {orderId?.slice(-12)}</div>
                </div>
                <div className="w-12"></div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#0B0E14] custom-scrollbar">
                {msgs.map(m => (
                    <div key={m.id} className={`p-3 rounded-2xl max-w-[85%] text-sm shadow-lg border ${m.senderId === (merchant?.id || user?.id) ? 'ml-auto bg-[#D4AF37] text-black border-[#F5C77A]/50 rounded-tr-none' : 'bg-[#1E293B] text-white border-slate-700 rounded-tl-none'}`}>
                        <div className="text-[9px] opacity-70 font-black mb-1 uppercase flex justify-between gap-4">
                            <span>{m.senderName}</span>
                            <span>{new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                        <div className="whitespace-pre-wrap leading-relaxed font-medium">{m.text}</div>
                        {m.attachmentUrl !== undefined && m.attachmentUrl !== null && m.attachmentUrl !== '' ? (
                            <div className="mt-2 rounded-lg overflow-hidden border border-black/20">
                                <img src={m.attachmentUrl} alt="attachment" className="max-w-full h-auto" />
                            </div>
                        ) : null}
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
            
            <div className="p-4 bg-[#1E293B] border-t border-slate-700">
                <div className="flex gap-2 items-center bg-[#0F172A] p-1.5 rounded-xl border border-slate-600 focus-within:border-[#D4AF37] transition-colors">
                    <button onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="p-3 text-slate-400 hover:text-[#D4AF37] bg-slate-800 rounded-lg disabled:opacity-50 transition-colors">
                        {isUploading ? '...' : '📎'}
                    </button>
                    <input type="file" ref={fileInputRef} className="hidden" accept="image/*,application/pdf" onChange={handleFileUpload} />
                    <input 
                        value={input} 
                        onChange={e => setInput(e.target.value)} 
                        className="flex-1 bg-transparent border-none px-2 py-2 text-sm text-white outline-none placeholder-slate-600" 
                        placeholder="Type a message..." 
                        onKeyDown={e => e.key === 'Enter' && send()}
                    />
                    <button onClick={send} className="bg-[#D4AF37] hover:bg-[#B8860B] text-black font-black px-6 py-2.5 rounded-lg transition-all active:scale-95 uppercase text-xs tracking-widest">Send</button>
                </div>
            </div>
        </div>
    );
};

const MerchantApp: React.FC = () => {
  return (
    <ErrorBoundary panel="merchant">
        <MerchantAuthProvider>
            <div className="min-h-screen bg-[#0B0E14] text-white font-sans selection:bg-[#D4AF37] selection:text-black">
                <Routes>
                    <Route path="/" element={<Navigate to="/merchant/login" replace />} />
                    <Route path="/login" element={<MerchantLogin />} />
                    <Route path="/dashboard" element={<MerchantDashboard />} />
                    <Route path="/queue" element={<QueueManagerDashboard />} />
                    <Route path="*" element={<Navigate to="/merchant/login" replace />} />
                </Routes>
            </div>
        </MerchantAuthProvider>
    </ErrorBoundary>
  );
};

export default MerchantApp;

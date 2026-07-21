// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect } from 'react';
import { useGame } from '../../services/GameContext';
import { Show } from '../ui/Show';

interface AuthModalProps {
    onClose?: () => void;
    initialMode?: "login" | "register";
}

const AuthModal: React.FC<AuthModalProps> = ({ onClose, initialMode }) => {
    const { login, register } = useGame();
    const [isLogin, setIsLogin] = useState(initialMode !== "register");
    const [mobile, setMobile] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const [refCode, setRefCode] = useState(() => sessionStorage.getItem('referral_code') || '');
    const [captcha, setCaptcha] = useState({ q: '', a: 0 });
    const [captchaInput, setCaptchaInput] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const generateCaptcha = () => {
        const n1 = Math.floor(Math.random() * 9) + 1;
        const n2 = Math.floor(Math.random() * 9) + 1;
        setCaptcha({ q: `${n1} + ${n2}`, a: n1 + n2 });
        setCaptchaInput('');
    };

    useEffect(() => { generateCaptcha(); }, [isLogin]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (parseInt(captchaInput) !== captcha.a) {
            setError("Incorrect Security Answer");
            generateCaptcha();
            return;
        }
        setLoading(true);
        try {
            let success = false;
            if (isLogin) {
                success = await login(mobile, password);
            } else {
                if (!username.trim()) throw new Error("Username required");
                success = await register(username, mobile, password, refCode.trim() || undefined);
            }
            if (!success) {
                setError("Authentication failed. Check credentials.");
                generateCaptcha();
            } else {
                if (refCode) sessionStorage.removeItem('referral_code');
                if (onClose) onClose();
            }
        } catch(e: any) {
            setError(e.message || "Something went wrong. Please try again.");
            generateCaptcha();
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <div className="w-full max-w-sm bg-[#1E293B] rounded-2xl border border-[#D4AF37] shadow-2xl p-8 relative overflow-y-auto max-h-[95vh] animate-in fade-in zoom-in duration-300">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#D4AF37] to-[#F5C77A] rounded-t-2xl"></div>
                {onClose && (
                    <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors" aria-label="Close">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                )}
                <div className="text-center mb-6">
                    <h1 className="text-2xl font-black text-white tracking-wider mb-2">BAZAAR CLASH</h1>
                    <p className="text-[#D4AF37] text-xs uppercase tracking-[0.2em] font-bold">
                        {isLogin ? 'Login to Play' : 'Create Account'}
                    </p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <Show when={!isLogin}>
                        <div>
                            <label className="text-xs text-slate-400 font-bold uppercase block mb-1">Username</label>
                            <input value={username} onChange={e => setUsername(e.target.value)}
                                className="w-full bg-[#0F172A] border border-slate-600 rounded-lg p-3 text-white focus:border-[#D4AF37] outline-none"
                                placeholder="PlayerOne" autoComplete="username" />
                        </div>
                    </Show>
                    <div>
                        <label className="text-xs text-slate-400 font-bold uppercase block mb-1">Mobile Number</label>
                        <input value={mobile} onChange={e => setMobile(e.target.value)}
                            className="w-full bg-[#0F172A] border border-slate-600 rounded-lg p-3 text-white focus:border-[#D4AF37] outline-none font-mono"
                            placeholder="9876543210" maxLength={10} inputMode="numeric" autoComplete="tel" />
                    </div>
                    <div>
                        <label className="text-xs text-slate-400 font-bold uppercase block mb-1">Password</label>
                        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                            className="w-full bg-[#0F172A] border border-slate-600 rounded-lg p-3 text-white focus:border-[#D4AF37] outline-none"
                            placeholder="••••••••" autoComplete={isLogin ? "current-password" : "new-password"} />
                    </div>
                    <Show when={!isLogin}>
                        <div>
                            <label className="text-xs text-slate-400 font-bold uppercase block mb-1">
                                Referral Code <span className="text-slate-600 normal-case font-normal">(optional)</span>
                            </label>
                            <input value={refCode} onChange={e => setRefCode(e.target.value.toUpperCase())}
                                className="w-full bg-[#0F172A] border border-slate-600 rounded-lg p-3 text-yellow-400 focus:border-[#D4AF37] outline-none font-mono tracking-widest uppercase"
                                placeholder="INVITE CODE" maxLength={10} autoComplete="off" />
                        </div>
                    </Show>
                    <div className="bg-[#0B0E14] p-3 rounded-xl border border-slate-700 flex items-center justify-between gap-4">
                        <div className="shrink-0">
                            <div className="text-[10px] text-slate-500 uppercase font-black mb-1">Security Check</div>
                            <div className="text-[#D4AF37] font-black text-lg tracking-widest">{captcha.q} = ?</div>
                        </div>
                        <input type="number" value={captchaInput} onChange={e => setCaptchaInput(e.target.value)}
                            className="w-20 bg-[#1E293B] border border-slate-600 rounded p-2 text-center text-white font-black"
                            placeholder="Ans" required inputMode="numeric" />
                    </div>
                    <Show when={!!error}>
                        <div className="bg-red-900/20 border border-red-500/50 p-2 rounded text-red-400 text-xs text-center font-bold">{error}</div>
                    </Show>
                    <button type="submit" disabled={loading}
                        className="w-full bg-[#D4AF37] hover:bg-[#B8860B] text-black font-bold py-3 rounded-xl shadow-lg transition-all active:scale-95 disabled:opacity-50 disabled:scale-100">
                        {loading ? 'Processing...' : (isLogin ? 'ENTER ARENA' : 'REGISTER NOW')}
                    </button>
                </form>
                <div className="mt-6 text-center space-y-2">
                    <button onClick={() => { setIsLogin(!isLogin); setError(''); setUsername(''); setRefCode(sessionStorage.getItem('referral_code') || ''); }}
                        className="text-slate-400 hover:text-white text-xs underline transition-colors block w-full">
                        {isLogin ? "New Player? Create Account" : "Already have an account? Login"}
                    </button>
                    {/* W-3 fix (Phase D, 2026-07-10): the recovery flow existed
                        (/recover-account + backend accountRecovery) but nothing
                        linked to it from login/signup. HashRouter → plain anchor
                        works from inside the modal and closes it via navigation. */}
                    <a href="#/recover-account" onClick={() => { if (onClose) onClose(); }}
                        className="text-slate-500 hover:text-[#D4AF37] text-xs underline transition-colors block w-full">
                        Lost access to your account? Recover it here
                    </a>
                </div>
            </div>
        </div>
    );
};

export default AuthModal;

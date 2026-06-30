// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { Lock, User, Mail, CheckCircle, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';

type Tab = 'login' | 'signup';

const LoginPage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('login');
  const { login } = useAuth();

  // Login state
  const [mobile, setMobile]     = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Signup state
  const [signupUsername, setSignupUsername]               = useState('');
  const [signupMobile, setSignupMobile]                   = useState('');
  const [signupEmail, setSignupEmail]                     = useState('');
  const [signupPassword, setSignupPassword]               = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupLoading, setSignupLoading]                 = useState(false);
  const [signupSuccess, setSignupSuccess]                 = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    try {
      await login({ mobile, password });
    } catch (error: any) {
      toast.error(error.message || 'Login failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signupPassword !== signupConfirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (signupPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setSignupLoading(true);
    try {
      const res = await api.merchantSignup({
        username: signupUsername,
        mobile: signupMobile,
        email: signupEmail || undefined,
        password: signupPassword,
        confirmPassword: signupConfirmPassword,
      });
      if (res.success) setSignupSuccess(true);
    } catch (error: any) {
      toast.error(error.message || 'Signup failed');
    } finally {
      setSignupLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-600 to-purple-700 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 px-8 py-6 text-white text-center">
          <h1 className="text-2xl font-bold">BB Token</h1>
          <p className="text-blue-100 text-sm mt-1">Merchant Panel</p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab('login')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'login' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Login
          </button>
          <button
            onClick={() => setTab('signup')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'signup' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Apply as Merchant
          </button>
        </div>

        <div className="px-8 py-6">
          {/* ── LOGIN TAB ── */}
          {tab === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mobile Number</label>
                <div className="relative">
                  <User className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <input
                    type="text" value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    placeholder="Enter mobile number"
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <input
                    type="password" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    required
                  />
                </div>
              </div>
              <button
                type="submit" disabled={loginLoading}
                className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 text-sm"
              >
                {loginLoading ? 'Logging in…' : 'Login'}
              </button>
              <p className="text-center text-xs text-gray-500">
                Don't have an account?{' '}
                <button type="button" onClick={() => setTab('signup')} className="text-blue-600 hover:underline">
                  Apply as a merchant
                </button>
              </p>
            </form>
          )}

          {/* ── SIGNUP TAB ── */}
          {tab === 'signup' && (
            signupSuccess ? (
              <div className="text-center py-6">
                <CheckCircle className="h-14 w-14 text-green-500 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Application Submitted!</h3>
                <p className="text-gray-500 text-sm leading-relaxed">
                  Your merchant application has been received. An admin will review and approve your account.
                  You can log in once approved.
                </p>
                <button
                  onClick={() => { setSignupSuccess(false); setTab('login'); }}
                  className="mt-6 text-blue-600 text-sm hover:underline"
                >
                  Back to Login
                </button>
              </div>
            ) : (
              <form onSubmit={handleSignup} className="space-y-3">
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-1">
                  <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-700">
                    Your application will be reviewed by an admin before you can login.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Username *</label>
                  <div className="relative">
                    <User className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input type="text" value={signupUsername} onChange={(e) => setSignupUsername(e.target.value)}
                      placeholder="Choose a username"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" required />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Mobile Number *</label>
                  <div className="relative">
                    <User className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input type="text" value={signupMobile} onChange={(e) => setSignupMobile(e.target.value)}
                      placeholder="10-digit mobile number"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" required />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email (optional)</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)}
                      placeholder="your@email.com"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Password *</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)}
                      placeholder="Min. 8 characters"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" required />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Confirm Password *</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input type="password" value={signupConfirmPassword} onChange={(e) => setSignupConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" required />
                  </div>
                </div>
                <button type="submit" disabled={signupLoading}
                  className="w-full bg-purple-600 text-white py-2.5 rounded-lg font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 text-sm">
                  {signupLoading ? 'Submitting…' : 'Submit Application'}
                </button>
                <p className="text-center text-xs text-gray-500">
                  Already approved?{' '}
                  <button type="button" onClick={() => setTab('login')} className="text-blue-600 hover:underline">Login here</button>
                </p>
              </form>
            )
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

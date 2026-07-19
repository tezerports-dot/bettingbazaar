// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Layers, Users } from 'lucide-react';
import { useAuthStore } from '../services/auth';
import { usePermissions } from '../hooks/usePermission';
import toast from 'react-hot-toast';

type LoginType = 'admin' | 'subadmin' | 'queue_manager';

const ROLES: { id: LoginType; label: string; icon: typeof Shield; color: string }[] = [
  { id: 'admin',         label: 'Admin',         icon: Shield, color: 'bg-gold-500 text-dark-900' },
  { id: 'subadmin',      label: 'Sub-Admin',      icon: Users,  color: 'bg-purple-500 text-white' },
  { id: 'queue_manager', label: 'Queue Manager',  icon: Layers, color: 'bg-blue-500 text-white'  },
];

export const Login: React.FC = () => {
  const [mobile, setMobile]         = useState('');
  const [password, setPassword]     = useState('');
  const [loginType, setLoginType]   = useState<LoginType>('admin');
  const [isLoading, setIsLoading]   = useState(false);
  const navigate                    = useNavigate();
  const { login }                   = useAuthStore();

  // We need defaultRoute AFTER login resolves, so we call it inside the handler
  // by accessing the store directly after the state update.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await login(mobile, password, loginType);

      // Read the store state right after login to decide where to redirect
      const { admin } = useAuthStore.getState();
      if (!admin) throw new Error('Login failed');

      if (admin.isAdmin) {
        navigate('/');
      } else if (admin.isQueueManager) {
        navigate('/queue-manager');
      } else {
        // Sub-admin: go to first permitted page
        const perms = (admin.permissions || {}) as import('../types').SubAdminPermissions;
        if (perms.canViewAnalytics) navigate('/');
        else if (perms.canManageUsers) navigate('/users');
        else if (perms.canManageMerchants) navigate('/merchants');
        else if (perms.canVerifyKYC) navigate('/kyc');
        else if (perms.canViewTransactions) navigate('/transactions');
        else if (perms.canManageContent) navigate('/content/faq');
        else navigate('/login'); // no permissions assigned yet
      }

      toast.success('Login successful!');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Login failed. Check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  const activeRole = ROLES.find((r) => r.id === loginType)!;

  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-gold-400 to-gold-600 rounded-2xl mb-4">
            <Shield size={32} className="text-dark-900" />
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
            {import.meta.env.VITE_APP_NAME || 'Betting Bazaar'}
          </h1>
          <p className="text-gray-400 mt-2">Admin Panel</p>
        </div>

        <div className="card">
          {/* Role selector */}
          <div className="flex rounded-lg overflow-hidden border border-dark-600 mb-6">
            {ROLES.map((role) => {
              const Icon = role.icon;
              const isActive = loginType === role.id;
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setLoginType(role.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                    isActive ? role.color : 'bg-dark-700 text-gray-400 hover:bg-dark-600'
                  }`}
                >
                  <Icon size={14} />
                  {role.label}
                </button>
              );
            })}
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="label">Mobile Number</label>
              <input
                type="tel"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                className="input"
                placeholder="Enter mobile number"
                required
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder="Enter password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={`w-full py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${activeRole.color}`}
            >
              {isLoading ? 'Logging in…' : `Login as ${activeRole.label}`}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          {/* H-07 fix: version from package.json via Vite, not a literal string.
              App name from branding bootstrap — GOVERNANCE §3 + §7 */}
          {import.meta.env.VITE_APP_NAME || 'Betting Bazaar'} Admin Panel v{import.meta.env.VITE_APP_VERSION || '—'}
        </p>
      </div>
    </div>
  );
};

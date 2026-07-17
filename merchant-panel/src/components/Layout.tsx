// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../services/AuthContext';
import { Home, Package, History, User, LogOut, Power } from 'lucide-react';
import { api } from '../services/api';
import toast from 'react-hot-toast';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant, logout, refreshProfile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { path: '/dashboard',    icon: Home,     label: 'Dashboard' },
    { path: '/orders',       icon: Package,  label: 'Orders' },
    { path: '/history',      icon: History,  label: 'History' },
    // Bulk Payouts removed — withdrawals are now instant per-order (Section 4B)
    { path: '/profile',      icon: User,     label: 'Profile' },
  ];

  const handleToggleOnline = async () => {
    try {
      await api.toggleOnlineStatus(!merchant?.isOnline);
      await refreshProfile();
      toast.success(merchant?.isOnline ? 'You are now offline' : 'You are now online');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update status');
    }
  };

  const handleNavigateToProfile = () => {
    navigate('/profile');
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-bold text-gray-900">BB Token Merchant</h1>
            </div>
            <div className="flex items-center space-x-4">
              {/* Online/Offline Toggle Button */}
              <button
                onClick={handleToggleOnline}
                className={`flex items-center space-x-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  merchant?.isOnline
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                title={merchant?.isOnline ? 'Click to go offline' : 'Click to go online'}
              >
                <Power className="h-4 w-4" />
                <span>{merchant?.isOnline ? 'Online' : 'Offline'}</span>
              </button>

              {/* Username */}
              <button
                onClick={handleNavigateToProfile}
                className="text-sm text-gray-700 hover:text-gray-900 font-medium"
              >
                {merchant?.username}
              </button>

              {/* Logout Button */}
              <button
                onClick={logout}
                className="flex items-center space-x-2 px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-white shadow-sm min-h-screen">
          <nav className="mt-5 px-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center px-4 py-3 mb-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Icon className="h-5 w-5 mr-3" />
                  <span className="font-medium">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* Online Status Indicator in Sidebar */}
          <div className="mt-8 px-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-xs text-gray-600 mb-2">Current Status</p>
              <div className="flex items-center space-x-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    merchant?.isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                  }`}
                />
                <span className="text-sm font-medium text-gray-900">
                  {merchant?.isOnline ? 'Available for Orders' : 'Not Accepting Orders'}
                </span>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;

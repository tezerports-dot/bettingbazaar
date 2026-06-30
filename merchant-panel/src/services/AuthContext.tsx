// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { MerchantProfile, LoginCredentials } from '../types';
import { api } from './api';

interface AuthContextType {
  merchant: MerchantProfile | null;
  loading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [merchant, setMerchant] = useState<MerchantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const initAuth = async () => {
      try {
        const isAuth = api.isAuthenticated();
        if (isAuth) {
          // First, set stale localStorage data so the UI isn't blank
          const cachedData = api.getCurrentMerchant();
          if (cachedData) setMerchant(cachedData);
          // Then immediately refresh from server so tokenBalance and status are live
          try {
            const freshData = await api.getMerchantProfile();
            if (freshData) {
              setMerchant(freshData);
              // Update localStorage with fresh data
              localStorage.setItem('merchantData', JSON.stringify(freshData));
            }
          } catch (refreshErr) {
            // Token may be expired — clear stale auth
            
            console.warn('Merchant profile refresh failed:', refreshErr);
            const isPublicRoute = ['/chat/'].some(p => window.location.pathname.startsWith(p));
            if (isPublicRoute) {
              setMerchant(null); 
            } else {
              api.logout();
              setMerchant(null);
            }
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        setLoading(false);
      }
    };
    initAuth();
  }, []);

  const login = async (credentials: LoginCredentials) => {
    try {
      setLoading(true);
      const response = await api.merchantLogin(credentials.mobile, credentials.password);
      const merchantData = response.user || response.merchant;
      if (merchantData) {
        setMerchant(merchantData);
        toast.success('Login successful!');
        navigate('/dashboard');
      }
    } catch (error: any) {
      toast.error(error.message || 'Login failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setMerchant(null);
    api.logout();
    
    const publicPaths = ['/chat/'];
    const isPublic = publicPaths.some(p => window.location.pathname.startsWith(p));
    if (!isPublic) {
      toast.success('Logged out');
      navigate('/');
    }
  };

  const refreshProfile = async () => {
    try {
      const freshData = await api.getMerchantProfile();
      setMerchant(freshData);
    } catch (error) {
      console.error('Failed to refresh profile:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ merchant, loading, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

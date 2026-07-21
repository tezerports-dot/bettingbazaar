// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../../services/logging.service';

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
  /** Tag crash reports so admin knows which panel crashed */
  panel?: 'user' | 'merchant';
}

interface State {
  hasError:    boolean;
  error?:      Error;
  isAdmin:     boolean;
  showDetails: boolean;
}

// FIX-4d: POST to /api/internal/error-report
// localStorage is origin-scoped — crash reports written in the user/merchant
// panel can never be read by the admin panel on a different domain/port.
// We POST to the shared backend instead.
const storeCrashReport = (
  error: Error,
  componentStack?: string,
  panel: 'user' | 'merchant' | 'unknown' = 'unknown',
): void => {
  const apiBase: string =
    (typeof (import.meta as any).env?.VITE_API_URL === 'string' &&
     (import.meta as any).env.VITE_API_URL.trim() !== '')
      ? (import.meta as any).env.VITE_API_URL.replace(/\/$/,  '')
      : window.location.origin;
  fetch(`${apiBase}/api/internal/error-report`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:    JSON.stringify({
      message:   error.message,
      stack:     error.stack,
      component: componentStack,
      ts:        new Date().toISOString(),
      url:       window.location.href,
      panel,
    }),
  }).catch(() => {});
};

const checkIsAdmin = (): boolean => {
  try {
    const token = localStorage.getItem('admin_token') || localStorage.getItem('auth_token');
    if (!token) return false;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload?.isAdmin === true || payload?.role === 'admin' || payload?.role === 'superadmin';
  } catch { return false; }
};

class ErrorBoundary extends Component<Props, State> {
  public readonly props: Props;
  public state: State = { hasError: false, isAdmin: false, showDetails: false };

  constructor(props: Props) {
    super(props);
    this.props = props;
  }

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, isAdmin: checkIsAdmin() };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(error, { componentStack: errorInfo.componentStack });
    storeCrashReport(
      error,
      errorInfo.componentStack ?? undefined,
      this.props.panel ?? 'unknown',
    );
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  private handleSoftReset = () => {
    this.setState({ hasError: false, error: undefined, showDetails: false });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const { error, isAdmin, showDetails } = this.state;

      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-[#0B0E14] text-[#EAEAEA] p-6 text-center font-inter z-[9999] relative">
          <div className="w-24 h-24 bg-red-900/20 border-2 border-red-500 rounded-full flex items-center justify-center text-5xl mb-6 shadow-[0_0_40px_rgba(239,68,68,0.4)] animate-pulse">
            💔
          </div>

          <h1 className="text-3xl font-black mb-2 text-white tracking-wide">Something went wrong</h1>

          <p className="text-slate-400 max-w-md mb-8 text-sm leading-relaxed">
            {isAdmin
              ? 'An unexpected error occurred. Details are visible below.'
              : "We're sorry — something went wrong on our end. Our team has been notified. Please try again in a moment."}
          </p>

          <div className="flex gap-4 mb-8">
            <button
              onClick={this.handleSoftReset}
              className="bg-[#D4AF37] hover:bg-[#B8860B] text-black font-bold py-3 px-8 rounded-xl shadow-[0_10px_20px_rgba(212,175,55,0.2)] transition-all active:scale-95 uppercase tracking-wide text-xs"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 px-8 rounded-xl border border-slate-600 transition-all active:scale-95 uppercase tracking-wide text-xs"
            >
              Reload Page
            </button>
          </div>

          {/* Admin only: collapsible error detail */}
          {isAdmin && (
            <div className="max-w-lg w-full">
              <button
                onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
                className="text-xs text-slate-500 hover:text-[#D4AF37] mb-3 transition-colors flex items-center gap-1 mx-auto"
              >
                <span>{showDetails ? '▾' : '▸'}</span>
                {showDetails ? 'Hide' : 'Show'} error details (admin)
              </button>
              {showDetails && (
                <div className="p-4 bg-black/60 rounded-xl border border-red-900/40 text-left space-y-3">
                  <div>
                    <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-1">Error</div>
                    <div className="text-sm text-red-400 font-mono break-all">{error?.message}</div>
                  </div>
                  {error?.stack && (
                    <div>
                      <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-1">Stack</div>
                      <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed">
                        {error.stack}
                      </pre>
                    </div>
                  )}
                  <div className="text-[10px] text-slate-600 pt-1 border-t border-slate-800">
                    Full crash reports → Admin Panel › System › Error Logs
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Users: incident timestamp only, no code details */}
          {!isAdmin && (
            <div className="text-[10px] text-slate-700 mt-4">
              Incident logged · {new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

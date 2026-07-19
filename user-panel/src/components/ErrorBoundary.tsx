// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';

interface EBState { hasError: boolean; error?: Error; }

export class ErrorBoundary extends React.Component<React.PropsWithChildren<{}>, EBState> {
    state: EBState = { hasError: false };

    static getDerivedStateFromError(error: Error): EBState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error.message, info.componentStack?.slice(0, 300));
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ minHeight: '100vh', background: '#0A0F1C', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', flexDirection: 'column', textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem', color: '#D4AF37' }}>
                        Something went wrong
                    </h2>
                    <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '0.5rem', maxWidth: '320px' }}>
                        The app hit an unexpected error. Your balance and bets are safe — please reload.
                    </p>
                    <p style={{ color: '#475569', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: '1.5rem', maxWidth: '320px', wordBreak: 'break-all' }}>
                        {this.state.error?.message}
                    </p>
                    <button onClick={() => window.location.reload()}
                        style={{ background: '#D4AF37', color: 'black', fontWeight: 700, padding: '0.75rem 2rem', borderRadius: '0.75rem', border: 'none', cursor: 'pointer', fontSize: '0.875rem' }}>
                        Reload App
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

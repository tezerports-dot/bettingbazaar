// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A screen that crashed: reported to the admin's error log as a crash
 * (services/errorReporter.ts) and replaced by a way back, instead of a blank
 * page (owner, 2026-10-20).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError, isStaleBuildError, reloadForNewBuild } from '../services/errorReporter';
import { Button } from './ui';

interface Props { children?: ReactNode }
interface State { failed: boolean }

export default class PanelErrorBoundary extends Component<Props, State> {
  public state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleBuildError(error) && reloadForNewBuild()) return;
    reportError('crash', error, info.componentStack ?? null);
  }

  public render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center', background: 'var(--bg)', color: 'var(--text)' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>Something went wrong on this screen</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 360 }}>It has been reported to the team. Reload to carry on; your orders are safe.</div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A screen that crashed: reported to the error log as a crash
 * (services/errorReporter.ts) and replaced by a way back, instead of a blank
 * panel (owner, 2026-10-20).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError, isStaleBuildError, reloadForNewBuild } from '../services/errorReporter';

interface Props { children?: ReactNode }
interface State { error: Error | null }

export default class PanelErrorBoundary extends Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleBuildError(error) && reloadForNewBuild()) return;
    reportError('crash', error, info.componentStack ?? null);
  }

  public render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-lg font-bold text-white">This screen stopped working</div>
        <div className="text-sm text-gray-400 max-w-md">It is in Error Logs now. Reload to carry on.</div>
        <pre className="text-xs text-red-400 font-mono max-w-xl whitespace-pre-wrap break-all">{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()} className="btn-primary">Reload</button>
      </div>
    );
  }
}

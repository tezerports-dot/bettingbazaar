// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { applyAppearance } from './services/theme';
import { installErrorReporter } from './services/errorReporter';
import PanelErrorBoundary from './components/PanelErrorBoundary';

// Uncaught errors and unhandled promises go to the error log.
installErrorReporter();

// Apply the persisted Command Center theme before first paint (no flash).
try {
  const persisted = JSON.parse(localStorage.getItem('admin-appearance') || '{}');
  applyAppearance(persisted?.state?.theme ?? 'dark', persisted?.state?.density ?? 'comfortable');
} catch {
  applyAppearance('dark');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PanelErrorBoundary>
      <App />
    </PanelErrorBoundary>
  </React.StrictMode>
);

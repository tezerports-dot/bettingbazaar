// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { applyTheme, readStoredTheme } from './theme';
import './index.css';

// Set the theme attribute before the first paint so the panel never flashes the
// wrong palette while React mounts.
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename="/merchant">
    <App />
    <Toaster
      position="top-center"
      toastOptions={{
        duration: 3200,
        style: {
          background: 'var(--elev)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          boxShadow: 'var(--shadow-lg)',
          fontSize: '13px',
          fontWeight: 700,
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        },
        success: { iconTheme: { primary: 'var(--ok)', secondary: 'var(--surface)' } },
        error: { iconTheme: { primary: 'var(--danger)', secondary: 'var(--surface)' } },
      }}
    />
  </BrowserRouter>
);

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App's entry (mini-app.html). No router, no socket, no session of
 * its own: see MiniApp.tsx.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import MiniApp from './MiniApp';
import { webApp } from './miniAppApi';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><MiniApp app={webApp()} /></React.StrictMode>,
);

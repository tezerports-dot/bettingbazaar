// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import MerchantApp from './MerchantApp';
import './index.css';

const rootElement = document.getElementById('merchant-root');
if (!rootElement) throw new Error("No root");

const root = ReactDOM.createRoot(rootElement);
root.render(
    <HashRouter>
        <MerchantApp />
    </HashRouter>
);

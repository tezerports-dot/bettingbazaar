import React from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/variables.css';
import VisualMappingApp from './VisualMappingApp.jsx';

const root = document.getElementById('root');
if (!root) throw new Error('Visual mapping layer requires #root');
createRoot(root).render(<React.StrictMode><VisualMappingApp /></React.StrictMode>);

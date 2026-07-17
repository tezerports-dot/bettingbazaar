import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { UI_PAGE_REGISTRY } from './views/UI_PAGE_REGISTRY.js';

/** Standalone visual mapping host; it deliberately owns no backend/domain state. */
export default function VisualMappingApp() {
  return <BrowserRouter><Routes>
    {UI_PAGE_REGISTRY.map(({ key, path, component: Component }) => <Route key={key} path={path} element={<Component />} />)}
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>;
}

import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { UI_PAGE_REGISTRY } from './views/UI_PAGE_REGISTRY.js';

/** Standalone visual mapping host; it deliberately owns no backend/domain state. */
function routeActiveLabel(key) {
  const labels = {
    main_bazaar_stage: 'Bazaar', casino_lobby: 'Casino', crash_arena: 'Crash', sports_book: 'Sports',
    wallet: 'Wallet', my_bets: 'My Bets', profile: 'Profile',
  };
  return labels[key] || 'Lobby';
}

export default function VisualMappingApp() {
  return <BrowserRouter><Routes>
    {UI_PAGE_REGISTRY.map(({ key, path, component: Component, layout: Layout }) => {
      const element = Layout ? <Layout active={routeActiveLabel(key)} activeKey={key}><Component /></Layout> : <Component />;
      return <Route key={key} path={path} element={element} />;
    })}
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>;
}

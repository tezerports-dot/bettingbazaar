import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function GameRegistry() {
  return <AdminPanelShell title={'Game Registry'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Game Registry"><p>API binding: <code>/api/game/admin/games, /api/game/admin/categories</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function GameProviders() {
  return <AdminPanelShell title={'Game Providers'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Game Providers"><p>API binding: <code>/api/game/admin/game-providers</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function WinnersManager() {
  return <AdminPanelShell title={'Winners Manager'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Winners Manager"><p>API binding: <code>/api/admin/fake-winners</code></p></VisualPage></AdminPanelShell>;
}

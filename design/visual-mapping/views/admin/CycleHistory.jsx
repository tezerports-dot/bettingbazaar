import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function CycleHistory() {
  return <AdminPanelShell title={'Cycle History'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Cycle History"><p>API binding: <code>/api/admin/cycles/history</code></p></VisualPage></AdminPanelShell>;
}

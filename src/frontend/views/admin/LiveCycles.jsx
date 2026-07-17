import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function LiveCycles() {
  return <AdminPanelShell title={'Live Cycles'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Live Cycles"><p>API binding: <code>/api/admin/cycles/phases</code></p></VisualPage></AdminPanelShell>;
}

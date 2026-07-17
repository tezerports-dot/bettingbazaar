import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function AdminDashboard() {
  return <AdminPanelShell title={'Operations Dashboard'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Operations Dashboard"><p>API binding: <code>/api/admin/analytics/dashboard</code></p></VisualPage></AdminPanelShell>;
}

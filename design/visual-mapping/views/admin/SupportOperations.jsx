import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function SupportOperations() {
  return <AdminPanelShell title={'Support Operations'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Support Operations"><p>API binding: <code>/api/admin/support/status, /api/admin/support/documents</code></p></VisualPage></AdminPanelShell>;
}

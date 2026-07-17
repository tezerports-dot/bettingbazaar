import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function AdminLogin() {
  return <AdminPanelShell title={'Admin Login'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Admin Login"><p>API binding: <code>/api/admin/login</code></p></VisualPage></AdminPanelShell>;
}

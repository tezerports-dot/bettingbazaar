import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function SubAdmins() {
  return <AdminPanelShell title={'Sub-Admins'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Sub-Admins"><p>API binding: <code>/api/admin/sub-admins</code></p></VisualPage></AdminPanelShell>;
}

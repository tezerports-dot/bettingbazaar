import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Users() {
  return <AdminPanelShell title={'Users'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Users"><p>API binding: <code>/api/admin/users</code></p></VisualPage></AdminPanelShell>;
}

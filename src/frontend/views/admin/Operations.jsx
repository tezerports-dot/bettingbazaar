import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Operations() {
  return <AdminPanelShell title={'Operations Overview'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Operations Overview"><p>API binding: <code>/api/admin/operations/overview</code></p></VisualPage></AdminPanelShell>;
}

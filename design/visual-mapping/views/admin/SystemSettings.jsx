import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function SystemSettings() {
  return <AdminPanelShell title={'System Settings'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="System Settings"><p>API binding: <code>/api/admin/system/config</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function RecoveryQueue() {
  return <AdminPanelShell title={'Account Recovery'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Account Recovery"><p>API binding: <code>/api/admin/account-recovery</code></p></VisualPage></AdminPanelShell>;
}

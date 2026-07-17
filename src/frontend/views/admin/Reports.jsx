import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Reports() {
  return <AdminPanelShell title={'Reports'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Reports"><p>API binding: <code>/api/admin/reports/ledger-export</code></p></VisualPage></AdminPanelShell>;
}

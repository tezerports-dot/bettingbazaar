import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function AuditLogs() {
  return <AdminPanelShell title={'Audit Logs'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Audit Logs"><p>API binding: <code>/api/admin/audit-logs</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function ErrorLogs() {
  return <AdminPanelShell title={'Error Logs'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Error Logs"><p>API binding: <code>/api/admin/error-reports</code></p></VisualPage></AdminPanelShell>;
}

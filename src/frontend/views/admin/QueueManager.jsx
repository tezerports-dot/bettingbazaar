import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function QueueManager() {
  return <AdminPanelShell title={'Queue Manager'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Queue Manager"><p>API binding: <code>/api/admin/queue/pending-orders</code></p></VisualPage></AdminPanelShell>;
}

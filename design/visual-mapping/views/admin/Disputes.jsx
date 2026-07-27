import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Disputes() {
  return <AdminPanelShell title={'Disputes'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Disputes"><p>API binding: <code>/api/admin/dispute-orders</code></p></VisualPage></AdminPanelShell>;
}

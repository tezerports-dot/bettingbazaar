import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Merchants() {
  return <AdminPanelShell title={'Merchants'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Merchants"><p>API binding: <code>/api/admin/merchants</code></p></VisualPage></AdminPanelShell>;
}

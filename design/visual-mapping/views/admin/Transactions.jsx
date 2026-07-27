import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Transactions() {
  return <AdminPanelShell title={'Transactions'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Transactions"><p>API binding: <code>/api/admin/transactions</code></p></VisualPage></AdminPanelShell>;
}

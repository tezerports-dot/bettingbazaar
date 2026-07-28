import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function DepositPolicy() {
  return <AdminPanelShell title={'Deposit Policy'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Deposit Policy"><p>API binding: <code>/api/admin/deposit-policy/:currency</code></p></VisualPage></AdminPanelShell>;
}

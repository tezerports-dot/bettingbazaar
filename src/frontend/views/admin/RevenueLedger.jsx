import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function RevenueLedger() {
  return <AdminPanelShell title={'Revenue & Ledger'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Revenue & Ledger"><p>API binding: <code>/api/admin/revenue/ledger</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function BalanceAdjustments() {
  return <AdminPanelShell title={'Balance Adjustments'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Balance Adjustments"><p>API binding: <code>/api/admin/balance-adjustments</code></p></VisualPage></AdminPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function ProfitLoss() {
  return <AdminPanelShell title={'Profit & Loss'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Profit & Loss"><p>API binding: <code>/api/admin/analytics/financials</code></p></VisualPage></AdminPanelShell>;
}

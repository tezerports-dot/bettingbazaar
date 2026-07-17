import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function PaymentControl() {
  return <AdminPanelShell title={'Payment Control Center'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Payment Control Center"><p>API binding: <code>/api/payment/admin/config, /api/admin/withdrawal-requests</code></p></VisualPage></AdminPanelShell>;
}

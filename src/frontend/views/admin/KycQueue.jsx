import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function KycQueue() {
  return <AdminPanelShell title={'KYC Queue'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="KYC Queue"><p>API binding: <code>/api/admin/kyc/queue</code></p></VisualPage></AdminPanelShell>;
}

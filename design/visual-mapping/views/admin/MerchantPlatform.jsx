import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function MerchantPlatform() {
  return <AdminPanelShell title={'Merchant Platform'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Merchant Platform"><p>API binding: <code>/api/admin/merchant-platform/leaderboard</code></p></VisualPage></AdminPanelShell>;
}

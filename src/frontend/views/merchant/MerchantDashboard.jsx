import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantDashboard() {
  return <MerchantPanelShell title={'Merchant Dashboard'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Merchant Dashboard"><p>API binding: <code>/api/merchant/stats, /api/merchant/earnings</code></p></VisualPage></MerchantPanelShell>;
}

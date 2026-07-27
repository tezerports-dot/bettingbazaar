import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantPayouts() {
  return <MerchantPanelShell title={'Payout Operations'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Payout Operations"><p>API binding: <code>/api/merchant/bulk-payouts, /api/merchant/bulk-payouts/export</code></p></VisualPage></MerchantPanelShell>;
}

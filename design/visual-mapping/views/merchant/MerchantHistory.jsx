import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantHistory() {
  return <MerchantPanelShell title={'Merchant History'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Merchant History"><p>API binding: <code>/api/merchant/orders, /api/merchant/earnings/weekly</code></p></VisualPage></MerchantPanelShell>;
}

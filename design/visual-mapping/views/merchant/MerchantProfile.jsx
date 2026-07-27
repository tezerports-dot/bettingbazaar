import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantProfile() {
  return <MerchantPanelShell title={'Merchant Profile'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Merchant Profile"><p>API binding: <code>/api/merchant/profile</code></p></VisualPage></MerchantPanelShell>;
}

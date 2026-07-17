import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantLogin() {
  return <MerchantPanelShell title={'Merchant Login'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Merchant Login"><p>API binding: <code>/api/merchant/auth/login</code></p></VisualPage></MerchantPanelShell>;
}

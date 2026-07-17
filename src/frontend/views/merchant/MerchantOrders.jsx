import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import MerchantPanelShell from '../../layouts/MerchantPanelShell.jsx';

export default function MerchantOrders() {
  return <MerchantPanelShell title={'Order Management'}><VisualPage eyebrow="MERCHANT VISUAL MAPPING" title="Order Management"><p>API binding: <code>/api/merchant/orders</code></p></VisualPage></MerchantPanelShell>;
}

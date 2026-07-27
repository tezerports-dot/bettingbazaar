import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Wallet() {
  return <UserPanelShell title={'Wallet'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Wallet"><p>API binding: <code>/api/v1/user/profile, /api/payment/orders, /api/v1/wallet/ledger</code></p></VisualPage></UserPanelShell>;
}

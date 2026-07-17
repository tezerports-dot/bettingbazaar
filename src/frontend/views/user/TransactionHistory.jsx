import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function TransactionHistory() {
  return <UserPanelShell title={'Transaction History'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Transaction History"><p>API binding: <code>/api/payment/orders</code></p></VisualPage></UserPanelShell>;
}

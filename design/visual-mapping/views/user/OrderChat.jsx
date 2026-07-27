import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function OrderChat() {
  return <UserPanelShell title={'Order Chat'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Order Chat"><p>API binding: <code>/api/payment/order/:orderId, /api/user/chat/:orderId/upload-url</code></p></VisualPage></UserPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function GiftCode() {
  return <UserPanelShell title={'Gift Code'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Gift Code"><p>API binding: <code>/api/giftcode/redeem</code></p></VisualPage></UserPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Vip() {
  return <UserPanelShell title={'VIP Club'}><VisualPage eyebrow="USER VISUAL MAPPING" title="VIP Club"><p>API binding: <code>/api/vip/config, /api/vip/my</code></p></VisualPage></UserPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Promotions() {
  return <UserPanelShell title={'Promotions'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Promotions"><p>API binding: <code>/api/announcements</code></p></VisualPage></UserPanelShell>;
}

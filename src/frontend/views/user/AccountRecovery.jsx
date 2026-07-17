import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function AccountRecovery() {
  return <UserPanelShell title={'Account Recovery'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Account Recovery"><p>API binding: <code>/api/auth/check-aadhaar, /api/auth/recover</code></p></VisualPage></UserPanelShell>;
}

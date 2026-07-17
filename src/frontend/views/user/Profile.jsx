import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Profile() {
  return <UserPanelShell title={'Profile & KYC'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Profile & KYC"><p>API binding: <code>/api/v1/user/profile, /api/user/:userId/kyc</code></p></VisualPage></UserPanelShell>;
}

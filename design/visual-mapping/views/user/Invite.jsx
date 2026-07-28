import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Invite() {
  return <UserPanelShell title={'Invite & Referral'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Invite & Referral"><p>API binding: <code>/api/referral/me, /api/referral/team, /api/referral/commissions</code></p></VisualPage></UserPanelShell>;
}

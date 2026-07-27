import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function MyBets() {
  return <UserPanelShell title={'My Bets'}><VisualPage eyebrow="USER VISUAL MAPPING" title="My Bets"><p>API binding: <code>/api/user/:userId/bets</code></p></VisualPage></UserPanelShell>;
}

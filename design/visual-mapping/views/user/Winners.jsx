import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Winners() {
  return <UserPanelShell title={'Winners'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Winners"><p>API binding: <code>/api/v1/winners, /api/leaderboard/:period</code></p></VisualPage></UserPanelShell>;
}

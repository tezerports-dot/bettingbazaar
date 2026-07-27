import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Results() {
  return <UserPanelShell title={'Results'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Results"><p>API binding: <code>/api/v1/game/cycles/history</code></p></VisualPage></UserPanelShell>;
}

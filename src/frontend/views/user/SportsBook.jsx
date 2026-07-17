import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function SportsBook() {
  return <UserPanelShell title={'Sportsbook'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Sportsbook"><p>API binding: <code>/api/game/games</code></p></VisualPage></UserPanelShell>;
}

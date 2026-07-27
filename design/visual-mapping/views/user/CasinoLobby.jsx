import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function CasinoLobby() {
  return <UserPanelShell title={'Casino Lobby'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Casino Lobby"><p>API binding: <code>/api/game/providers, /api/game/games</code></p></VisualPage></UserPanelShell>;
}

import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function CrashArena() {
  return <UserPanelShell title={'Crash Arena'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Crash Arena"><p>API binding: <code>/api/game/launch</code></p></VisualPage></UserPanelShell>;
}

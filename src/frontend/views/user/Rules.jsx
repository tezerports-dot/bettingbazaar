import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Rules() {
  return <UserPanelShell title={'Rules & Responsible Play'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Rules & Responsible Play"><p>API binding: <code>/api/v1/system/config</code></p></VisualPage></UserPanelShell>;
}

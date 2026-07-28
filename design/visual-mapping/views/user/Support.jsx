import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Support() {
  return <UserPanelShell title={'Support'}><VisualPage eyebrow="USER VISUAL MAPPING" title="Support"><p>API binding: <code>/api/v1/content/support-links, /api/support/ask</code></p></VisualPage></UserPanelShell>;
}

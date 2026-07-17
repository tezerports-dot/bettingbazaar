import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import UserPanelShell from '../../layouts/UserPanelShell.jsx';

export default function Faq() {
  return <UserPanelShell title={'FAQ'}><VisualPage eyebrow="USER VISUAL MAPPING" title="FAQ"><p>API binding: <code>/api/v1/content/faq</code></p></VisualPage></UserPanelShell>;
}
